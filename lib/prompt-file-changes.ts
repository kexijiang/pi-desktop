import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getRuntimeAgentDataDirectory } from "./runtime-home";
import { parseGitPorcelainV1 } from "./git-status";
import type { PromptRunIdentity } from "./prompt-run-registry";
import {
  buildRunFilePatchAsync,
  computeRunFileFingerprint,
  decodeRunTextDetailed,
  MAX_RUN_PATCH_BYTES,
  MAX_RUN_PATCH_FILES,
  MAX_RUN_TEXT_FILE_BYTES,
  MAX_RUN_TEXT_SNAPSHOT_BYTES,
  readRunTextDetailed,
  readVerifiedWorkspaceFile,
  type DecodedRunText,
  type RunPatchUnavailableReason,
} from "./file-changes/run-patch";
import { RunPatchCache } from "./file-changes/run-patch-cache";
import { captureGitArgs, findGitCaptureRoot } from "./file-changes/git-workspace";
import {
  pinWorkspaceRoot,
  workspaceContainsPath,
  workspaceRootIsCurrent,
  type CapturedWorkspaceRoot,
} from "./file-changes/workspace-file";

const execFileAsync = promisify(execFile);
const MAX_FILES = 5000;
const MAX_GIT_TRACKED_FILES = 100_000;
const MAX_DEPTH = 8;
const MAX_HASH_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RUN_DIFF_TOTAL_MS = 2_500;
const LIVE_CACHE_TTL_MS = 1_500;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".cache", ".turbo", "vendor", "target", "__pycache__"]);

export interface PromptFileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  additions?: number;
  deletions?: number;
  patchRevision?: string;
  unavailableReason?: RunPatchUnavailableReason;
}

export interface PromptFileChanges {
  sessionId: string;
  runId: string;
  cwd: string;
  captureRoot?: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "complete" | "aborted" | "error" | "unavailable";
  partial: boolean;
  files: PromptFileChange[];
}

type RecordedPromptFileChange = PromptFileChange & { patch?: string };
type RecordedPromptFileChanges = Omit<PromptFileChanges, "files"> & {
  captureRootIdentity?: string;
  files: RecordedPromptFileChange[];
};
type PromptFileChangesScope = Pick<RecordedPromptFileChanges,
  "sessionId" | "runId" | "cwd" | "captureRoot" | "captureRootIdentity" | "status">;

interface Snapshot {
  root: CapturedWorkspaceRoot;
  git: boolean;
  gitHash?: "sha1" | "sha256";
  versions: Map<string, string>;
  paths: Map<string, string>;
  texts: Map<string, DecodedRunText>;
  dirtyPaths?: Set<string>;
  partial: boolean;
}

export interface PromptFileCapture {
  identity: PromptRunIdentity;
  initial: Promise<Snapshot>;
  initialSettled?: Snapshot;
  startedAt: number;
  cwd: string;
  touchedPaths: Set<string>;
  touchedDisplayPaths: Map<string, string>;
  touchedPending: Map<string, Promise<void>>;
  touchedBaselines: Map<string, string>;
  touchedTexts: Map<string, DecodedRunText>;
  touchedBudget: FingerprintBudget;
  patchCache: RunPatchCache;
  liveCache?: { at: number; record: RecordedPromptFileChanges };
  liveInflight?: Promise<RecordedPromptFileChanges>;
}

declare global {
  var __pioraActivePromptFileChanges: Map<string, RecordedPromptFileChanges> | undefined;
  var __pioraActivePromptFileCaptures: Map<string, PromptFileCapture> | undefined;
}

function getActive(): Map<string, RecordedPromptFileChanges> {
  return globalThis.__pioraActivePromptFileChanges ??= new Map();
}

function getCaptures(): Map<string, PromptFileCapture> {
  return globalThis.__pioraActivePromptFileCaptures ??= new Map();
}

function pathKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function isLowPriorityPatchFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return base === "package-lock.json"
    || base === "pnpm-lock.yaml"
    || base === "yarn.lock"
    || base === "bun.lock"
    || base.endsWith(".min.js")
    || base.endsWith(".min.css")
    || base.endsWith(".map");
}

function storagePath(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(getRuntimeAgentDataDirectory(), "piora", "prompt-file-changes", `${key}.json`);
}

async function persist(record: RecordedPromptFileChanges): Promise<void> {
  const target = storagePath(record.sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record), "utf8");
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

interface PendingDiffEntry {
  key: string;
  displayPath: string;
  oldVersion: string | undefined;
  newVersion: string | undefined;
  change: RecordedPromptFileChange;
  priority: number;
  caseOnlyRename?: boolean;
}

async function diffSnapshots(before: Snapshot, after: Snapshot, capture: PromptFileCapture): Promise<RecordedPromptFileChange[]> {
  const pending: PendingDiffEntry[] = [];
  const allKeys = new Set([...before.versions.keys(), ...after.versions.keys(), ...capture.touchedPaths]);
  for (const key of allKeys) {
    const oldVersion = before.versions.get(key) ?? capture.touchedBaselines.get(key);
    const newVersion = after.versions.get(key);
    const beforePath = before.paths.get(key);
    const afterPath = after.paths.get(key);
    const caseOnlyRename = Boolean(
      process.platform === "win32"
      && oldVersion !== undefined
      && oldVersion !== "missing"
      && oldVersion === newVersion
      && beforePath
      && afterPath
      && beforePath !== afterPath
      && beforePath.toLowerCase() === afterPath.toLowerCase(),
    );
    if (oldVersion === newVersion && !caseOnlyRename) continue;
    if ((oldVersion === undefined || oldVersion === "missing") && (newVersion === undefined || newVersion === "missing")) continue;
    const displayPath = afterPath ?? beforePath ?? capture.touchedDisplayPaths.get(key) ?? key;
    const change: RecordedPromptFileChange = {
      path: displayPath,
      kind: newVersion === undefined || newVersion === "missing"
        ? "deleted"
        : oldVersion === undefined || oldVersion === "missing"
          ? "added"
          : "modified",
      ...(caseOnlyRename ? { unavailableReason: "path_case_only" as const } : {}),
    };
    pending.push({
      key,
      displayPath,
      oldVersion,
      newVersion,
      change,
      priority: isLowPriorityPatchFile(displayPath) ? 1 : 0,
      caseOnlyRename,
    });
  }

  // Generate diffs for normal source files before lockfiles/bundles so large
  // generated diffs never starve regular edited files out of the byte budget.
  pending.sort((a, b) => a.priority - b.priority || a.displayPath.localeCompare(b.displayPath));

  const diffStartedAt = Date.now();
  let patchBytes = 0;
  let patchedCount = 0;
  let attemptCount = 0;
  for (const item of pending) {
    const { key, displayPath, oldVersion, newVersion, change, caseOnlyRename } = item;
    if (caseOnlyRename) continue;

    const version = [displayPath, oldVersion ?? "", newVersion ?? ""].join("\0");
    const cached = capture.patchCache.get(key, version);
    if (cached) {
      const size = Buffer.byteLength(cached.patch);
      if (patchedCount < MAX_RUN_PATCH_FILES && patchBytes + size <= MAX_RUN_PATCH_BYTES) {
        patchBytes += size;
        patchedCount += 1;
        Object.assign(change, cached);
      } else {
        change.unavailableReason = "budget_exceeded";
      }
      continue;
    }

    const elapsedMs = Date.now() - diffStartedAt;
    if (
      attemptCount >= MAX_RUN_PATCH_FILES
      || patchedCount >= MAX_RUN_PATCH_FILES
      || patchBytes >= MAX_RUN_PATCH_BYTES
      || elapsedMs >= MAX_RUN_DIFF_TOTAL_MS
    ) {
      change.unavailableReason = "budget_exceeded";
      continue;
    }
    attemptCount += 1;

    const [original, edited] = await Promise.all([
      readRunTextDetailed(before.root, oldVersion, before.texts.get(key) ?? capture.touchedTexts.get(key), undefined, before.gitHash),
      readRunTextDetailed(
        after.root,
        newVersion,
        after.texts.get(key),
        change.kind === "deleted" ? undefined : displayPath,
        after.gitHash,
      ),
    ]);

    if (!original.ok) {
      change.unavailableReason = original.reason;
      continue;
    }
    if (!edited.ok) {
      change.unavailableReason = edited.reason;
      continue;
    }

    const remainingTimeMs = MAX_RUN_DIFF_TOTAL_MS - (Date.now() - diffStartedAt);
    const built = await buildRunFilePatchAsync(after.root.path, displayPath, original, edited, change.kind, remainingTimeMs);
    if (built.detail) {
      const size = Buffer.byteLength(built.detail.patch);
      if (patchBytes + size <= MAX_RUN_PATCH_BYTES) {
        patchBytes += size;
        patchedCount += 1;
        const result = {
          ...built.detail,
          patchRevision: createHash("sha256").update(built.detail.patch).digest("hex").slice(0, 16),
        };
        Object.assign(change, result);
        capture.patchCache.set(key, version, result);
      } else {
        change.unavailableReason = "budget_exceeded";
      }
    } else if (built.unavailableReason) {
      change.unavailableReason = built.unavailableReason;
    }
  }

  return pending
    .map((item) => item.change)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function runScope(record: RecordedPromptFileChanges): PromptFileChangesScope {
  const { sessionId, runId, cwd, captureRoot, captureRootIdentity, status } = record;
  return { sessionId, runId, cwd, captureRoot, captureRootIdentity, status };
}

async function readActivePromptFileChanges(running: RecordedPromptFileChanges): Promise<RecordedPromptFileChanges> {
  const { sessionId } = running;
  const capture = getCaptures().get(sessionId);
  const before = capture?.initialSettled;
  if (running.status !== "running" || !capture || !before || capture.identity.runId !== running.runId) return running;
  if (capture.liveCache && Date.now() - capture.liveCache.at < LIVE_CACHE_TTL_MS) {
    return capture.liveCache.record;
  }
  if (!capture.liveInflight) {
    capture.liveInflight = (async () => {
      const after = await snapshot(capture.cwd, before, capture.touchedDisplayPaths.values());
      const files = await diffSnapshots(before, after, capture);
      const record: RecordedPromptFileChanges = {
        ...running,
        partial: before.partial || after.partial || capture.touchedBudget.partial,
        files,
      };
      if (getActive().get(sessionId) === running) capture.liveCache = { at: Date.now(), record };
      return record;
    })().catch(() => ({ ...running, partial: true })).finally(() => {
      capture.liveInflight = undefined;
    });
  }
  return capture.liveInflight;
}

/** Inspect and authorize the same run before its live diff reads any workspace files. */
export async function preparePromptFileChanges(sessionId: string): Promise<{
  scope: PromptFileChangesScope;
  read(): Promise<RecordedPromptFileChanges | null>;
} | null> {
  const active = getActive().get(sessionId);
  if (active) {
    const scope = runScope(active);
    const isCurrent = () => getActive().get(sessionId) === active
      && active.captureRootIdentity === scope.captureRootIdentity;
    return {
      scope,
      async read() {
        if (!isCurrent()) return null;
        const changes = await readActivePromptFileChanges(active);
        return isCurrent() ? changes : null;
      },
    };
  }
  try {
    const parsed = JSON.parse(await fs.readFile(storagePath(sessionId), "utf8")) as RecordedPromptFileChanges;
    if (parsed.sessionId !== sessionId) return null;
    // An in-progress record left on disk after a process restart has no live
    // capture to finish it. Make that gap explicit instead of showing a spinner.
    const record = parsed.status === "running" ? { ...parsed, status: "unavailable" as const, partial: true } : parsed;
    return {
      scope: runScope(record),
      async read() { return getActive().has(sessionId) ? null : record; },
    };
  } catch { return null; }
}

function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  let probe = resolved;
  const trailing: string[] = [];
  while (true) {
    try {
      const real = realpathSync.native(probe);
      return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolved;
      trailing.push(path.basename(probe));
      probe = parent;
    }
  }
}

function safeAbsolute(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  const fromRoot = path.relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null;
  return absolute;
}

interface FingerprintBudget {
  remaining: number;
  textRemaining: number;
  partial: boolean;
}

async function fingerprint(
  root: CapturedWorkspaceRoot,
  file: string,
  key: string,
  budget: FingerprintBudget,
  texts: Map<string, DecodedRunText>,
  gitHash?: "sha1" | "sha256",
  skipTextIfVersionEquals?: string,
): Promise<string> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) { budget.partial = true; return "missing"; }
    const maxBytes = Math.min(MAX_SINGLE_FILE_BYTES, budget.remaining);
    const verified = await readVerifiedWorkspaceFile(root, file, { maxBytes });
    if (!verified.ok) {
      budget.partial = true;
      return verified.reason === "too_large" ? ["metadata", verified.size, verified.revision].join(":") : "missing";
    }
    const { data } = verified;
    budget.remaining -= data.length;
    const version = computeRunFileFingerprint(data, gitHash);
    if (
      version !== skipTextIfVersionEquals
      && data.length <= MAX_RUN_TEXT_FILE_BYTES
      && data.length <= budget.textRemaining
    ) {
      const decoded = decodeRunTextDetailed(data);
      if (decoded.ok) {
        budget.textRemaining -= data.length;
        texts.set(key, { text: decoded.text, encoding: decoded.encoding, lineEnding: decoded.lineEnding });
      }
    }
    return version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") budget.partial = true;
    return "missing";
  }
}

async function gitPaths(root: string): Promise<{ paths: string[]; partial: boolean }> {
  const { stdout } = await execFileAsync("git", [...captureGitArgs(root), "-c", "status.relativePaths=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true });
  const entries = parseGitPorcelainV1(stdout);
  // A staged-only entry already has the correct baseline in the index.
  const paths = [...new Set(entries.filter((entry) => entry.worktreeStatus !== " ")
    .flatMap((entry) => entry.worktreeStatus === "R" && entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]))];
  return { paths: paths.slice(0, MAX_FILES), partial: paths.length > MAX_FILES };
}

async function gitTrackedVersions(root: string): Promise<{ versions: Map<string, string>; paths: Map<string, string>; partial: boolean }> {
  const { stdout } = await execFileAsync("git", [...captureGitArgs(root), "ls-files", "--cached", "--stage", "-z"], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true });
  const versions = new Map<string, string>();
  const paths = new Map<string, string>();
  let partial = false;
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const header = separator >= 0 ? entry.slice(0, separator) : "";
    const match = /^\d+ ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
    if (!match || separator < 0) { partial = true; continue; }
    const absolute = safeAbsolute(root, entry.slice(separator + 1));
    if (!absolute) continue;
    const key = pathKey(absolute);
    if (versions.size >= MAX_GIT_TRACKED_FILES && !versions.has(key)) { partial = true; break; }
    // A clean tracked file has the index blob as its content baseline. Dirty
    // paths below are replaced with a hash of the actual working file.
    versions.set(key, `git:${match[1]}`);
    paths.set(key, absolute);
    if (match[2] !== "0") partial = true;
  }
  return { versions, paths, partial };
}

async function gitSnapshot(
  root: CapturedWorkspaceRoot,
  extraPaths: Iterable<string> = [],
  previousDirtyPaths?: ReadonlySet<string>,
  beforeVersions?: ReadonlyMap<string, string>,
): Promise<Snapshot> {
  const [listing, tracked] = await Promise.all([gitPaths(root.path), gitTrackedVersions(root.path)]);
  const versions = tracked.versions;
  const paths = tracked.paths;
  const gitHash = [...versions.values()].some((version) => version.length === 68) ? "sha256" : "sha1";
  const dirtyPaths = new Set<string>();
  const candidates = new Map<string, string>();
  const texts = new Map<string, DecodedRunText>();
  for (const relative of listing.paths) {
    const absolute = safeAbsolute(root.path, relative);
    if (!absolute) continue;
    const key = pathKey(absolute);
    dirtyPaths.add(key);
    candidates.set(key, absolute);
    paths.set(key, absolute);
  }
  for (const raw of extraPaths) {
    const absolute = safeAbsolute(root.path, raw);
    if (!absolute) continue;
    const diskPath = process.platform === "win32" ? canonicalPath(absolute) : absolute;
    if (!workspaceContainsPath(root.path, diskPath)) continue;
    const key = pathKey(diskPath);
    if (!candidates.has(key)) candidates.set(key, diskPath);
    paths.set(key, diskPath);
  }
  if (previousDirtyPaths) {
    for (const previous of previousDirtyPaths) {
      const key = pathKey(previous);
      if (!candidates.has(key)) candidates.set(key, previous);
      if (!paths.has(key)) paths.set(key, previous);
    }
  }
  const budget = { remaining: MAX_HASH_BYTES, textRemaining: MAX_RUN_TEXT_SNAPSHOT_BYTES, partial: listing.partial || tracked.partial || candidates.size > MAX_FILES };
  let hashed = 0;
  for (const [key, absolute] of candidates) {
    // Keep Git's normalized blob for clean tracked files, including CRLF
    // checkouts. Explicitly touched ignored files are still fingerprinted.
    if (versions.has(key) && !dirtyPaths.has(key)) continue;
    if (hashed >= MAX_FILES) {
      budget.partial = true;
      break;
    }
    hashed += 1;
    versions.set(
      key,
      await fingerprint(root, absolute, key, budget, texts, gitHash, beforeVersions?.get(key)),
    );
  }
  const dirtyDisplayPaths = new Set<string>();
  for (const key of dirtyPaths) {
    dirtyDisplayPaths.add(paths.get(key) ?? key);
  }
  return { root, git: true, gitHash, versions, paths, texts, dirtyPaths: dirtyDisplayPaths, partial: budget.partial };
}

async function plainSnapshot(
  root: CapturedWorkspaceRoot,
  extraPaths: Iterable<string> = [],
  beforeVersions?: ReadonlyMap<string, string>,
): Promise<Snapshot> {
  const versions = new Map<string, string>();
  const paths = new Map<string, string>();
  const texts = new Map<string, DecodedRunText>();
  const budget = { remaining: MAX_HASH_BYTES, textRemaining: MAX_RUN_TEXT_SNAPSHOT_BYTES, partial: false };
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root.path, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const { directory, depth } = queue[index];
    let entries: import("node:fs").Dirent[];
    try {
      if (await fs.realpath(directory) !== directory) { budget.partial = true; continue; }
      entries = await fs.readdir(directory, { withFileTypes: true });
    }
    catch { budget.partial = true; continue; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) queue.push({ directory: absolute, depth: depth + 1 });
        else budget.partial = true;
      } else if (entry.isFile()) {
        if (versions.size >= MAX_FILES) { budget.partial = true; break; }
        const key = pathKey(absolute);
        paths.set(key, absolute);
        versions.set(
          key,
          await fingerprint(root, absolute, key, budget, texts, undefined, beforeVersions?.get(key)),
        );
      }
    }
    if (versions.size >= MAX_FILES) break;
  }
  for (const raw of extraPaths) {
    const absolute = safeAbsolute(root.path, raw);
    if (!absolute) continue;
    const key = pathKey(absolute);
    if (!versions.has(key)) {
      paths.set(key, absolute);
      versions.set(
        key,
        await fingerprint(root, absolute, key, budget, texts, undefined, beforeVersions?.get(key)),
      );
    }
  }
  return { root, git: false, versions, paths, texts, partial: budget.partial };
}

async function snapshot(
  cwd: string,
  initial?: Snapshot,
  touchedPaths?: Iterable<string>,
): Promise<Snapshot> {
  const workspace = initial?.root ?? await pinWorkspaceRoot(cwd);
  if (!workspace) throw new Error("Workspace unavailable");
  const discoveredGitRoot = initial ? null : await findGitCaptureRoot(workspace);
  const root = discoveredGitRoot ?? workspace;
  const git = initial?.git ?? discoveredGitRoot !== null;
  if (!await workspaceRootIsCurrent(workspace) || (root !== workspace && !await workspaceRootIsCurrent(root))) {
    throw new Error("Workspace moved during capture");
  }
  const captured = git
    ? await gitSnapshot(root, touchedPaths, initial?.dirtyPaths, initial?.versions)
    : await plainSnapshot(root, touchedPaths, initial?.versions);
  if (!await workspaceRootIsCurrent(root)) throw new Error("Workspace moved during capture");
  return captured;
}

export async function recordPromptFileTouch(sessionId: string, rawPath: string, cwd: string): Promise<void> {
  const capture = getCaptures().get(sessionId);
  const active = getActive().get(sessionId);
  if (!capture || !active || active.runId !== capture.identity.runId || active.status !== "running") return;
  const trimmed = rawPath.trim();
  if (!trimmed) return;
  const baseCwd = canonicalPath(cwd || capture.cwd);
  const candidate = canonicalPath(path.resolve(baseCwd, trimmed));
  const initialSnap = capture.initialSettled ?? await capture.initial.catch(() => undefined);
  const allowedRoot = initialSnap?.root;
  if (!allowedRoot || candidate === allowedRoot.path || !workspaceContainsPath(allowedRoot.path, candidate)) {
    return;
  }
  const key = pathKey(candidate);
  if (getCaptures().get(sessionId) !== capture || capture.touchedPaths.has(key)) return;
  let pending = capture.touchedPending.get(key);
  if (!pending) {
    pending = (async () => {
      const existingVersion = initialSnap?.versions.get(key);
      if (existingVersion !== undefined) {
        capture.touchedBaselines.set(key, existingVersion);
        // If the file was already dirty before this run and initial text capture
        // skipped it due to snapshot budget, backfill only if fingerprint matches
        // and within the touched text byte budget.
        const isDirtyBaseline = !initialSnap?.git
          || Boolean(initialSnap.dirtyPaths && [...initialSnap.dirtyPaths].some((entry) => pathKey(entry) === key));
        if (isDirtyBaseline && !initialSnap?.texts.has(key) && !capture.touchedTexts.has(key)) {
          const maxBytes = Math.min(MAX_RUN_TEXT_FILE_BYTES, capture.touchedBudget.textRemaining);
          if (maxBytes > 0) {
            const verified = await readVerifiedWorkspaceFile(allowedRoot, candidate, {
              maxBytes,
              expectedVersion: existingVersion,
              gitHash: initialSnap?.gitHash,
            });
            if (verified.ok) {
              const decoded = decodeRunTextDetailed(verified.data);
              if (decoded.ok) {
                capture.touchedBudget.textRemaining -= verified.data.length;
                capture.touchedTexts.set(key, {
                  text: decoded.text,
                  encoding: decoded.encoding,
                  lineEnding: decoded.lineEnding,
                });
              }
            } else if (verified.reason === "too_large") {
              capture.touchedBudget.partial = true;
            }
          } else {
            capture.touchedBudget.partial = true;
          }
        }
      } else {
        const baseline = await fingerprint(
          allowedRoot, candidate, key, capture.touchedBudget, capture.touchedTexts, initialSnap?.gitHash,
        );
        capture.touchedBaselines.set(key, baseline);
      }
      capture.touchedPaths.add(key);
      capture.touchedDisplayPaths.set(key, candidate);
      capture.liveCache = undefined;
    })().finally(() => capture.touchedPending.delete(key));
    capture.touchedPending.set(key, pending);
  }
  await pending;
}

export function beginPromptFileChanges(identity: PromptRunIdentity, cwd: string): PromptFileCapture {
  const startedAt = Date.now();
  const record: RecordedPromptFileChanges = { sessionId: identity.sessionId, runId: identity.runId, cwd, startedAt, status: "running", partial: false, files: [] };
  getActive().set(identity.sessionId, record);
  const initial: Promise<Snapshot> = Promise.all([snapshot(cwd), persist(record).catch(() => {})]).then(([value]) => {
    record.captureRoot = value.root.path;
    record.captureRootIdentity = value.root.identity;
    capture.initialSettled = value;
    return value;
  });
  void initial.catch(() => { record.partial = true; });
  const capture: PromptFileCapture = {
    identity,
    cwd,
    startedAt,
    touchedPaths: new Set(),
    touchedDisplayPaths: new Map(),
    touchedPending: new Map(),
    touchedBaselines: new Map(),
    touchedTexts: new Map(),
    touchedBudget: { remaining: MAX_HASH_BYTES, textRemaining: MAX_RUN_TEXT_SNAPSHOT_BYTES, partial: false },
    patchCache: new RunPatchCache(),
    initial,
  };
  getCaptures().set(identity.sessionId, capture);
  return capture;
}

export async function finishPromptFileChanges(capture: PromptFileCapture, status: "complete" | "aborted" | "error"): Promise<RecordedPromptFileChanges> {
  const { identity, cwd, startedAt } = capture;
  let result: RecordedPromptFileChanges;
  try {
    const before = await capture.initial;
    const after = await snapshot(cwd, before, capture.touchedDisplayPaths.values());
    const files = await diffSnapshots(before, after, capture);
    result = {
      sessionId: identity.sessionId,
      runId: identity.runId,
      cwd,
      captureRoot: before.root.path,
      captureRootIdentity: before.root.identity,
      startedAt,
      finishedAt: Date.now(),
      status,
      partial: before.partial || after.partial || capture.touchedBudget.partial,
      files,
    };
  } catch {
    result = { sessionId: identity.sessionId, runId: identity.runId, cwd, startedAt, finishedAt: Date.now(), status: "unavailable", partial: true, files: [] };
  } finally {
    if (getCaptures().get(identity.sessionId) === capture) {
      getCaptures().delete(identity.sessionId);
    }
  }
  if (getActive().get(identity.sessionId)?.runId === identity.runId) {
    getActive().set(identity.sessionId, result);
    try {
      await persist(result);
      if (getActive().get(identity.sessionId) === result) getActive().delete(identity.sessionId);
    }
    catch { /* Keep the result available in memory. */ }
  }
  return result;
}
