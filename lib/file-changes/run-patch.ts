import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { formatPatch, structuredPatch } from "diff";
import { captureGitArgs } from "./git-workspace";
import { readWorkspaceFile, workspaceRootIsCurrent, type CapturedWorkspaceRoot } from "./workspace-file";

const execFileAsync = promisify(execFile);
export const MAX_RUN_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_RUN_TEXT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_RUN_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_PATCH_FILES = 150;
const JS_DIFF_TIMEOUT_MS = 150;
const JS_DIFF_MAX_EDIT_LENGTH = 25_000;

export type RunPatchUnavailableReason =
  | "too_large"
  | "binary"
  | "line_endings_only"
  | "encoding_only"
  | "path_case_only"
  | "budget_exceeded"
  | "diff_unavailable";

export type RunTextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";
export type RunTextLineEnding = "none" | "lf" | "crlf" | "cr" | "mixed";

export interface DecodedRunText {
  text: string;
  encoding: RunTextEncoding;
  lineEnding: RunTextLineEnding;
}

export type RunTextDecodeResult =
  | ({ ok: true } & DecodedRunText)
  | { ok: false; reason: "too_large" | "binary" | "diff_unavailable" };

export interface RunFilePatchDetail {
  patch: string;
  additions: number;
  deletions: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf16le = new TextDecoder("utf-16le", { fatal: true });
const utf16be = new TextDecoder("utf-16be", { fatal: true });

export function computeRunFileFingerprint(data: Buffer, gitHash?: "sha1" | "sha256"): string {
  return gitHash
    ? `git:${createHash(gitHash).update(`blob ${data.length}\0`).update(data).digest("hex")}`
    : createHash("sha256").update(data).digest("hex");
}

function inferGitHashFromVersion(version: string): "sha1" | "sha256" | undefined {
  const match = /^git:([a-f0-9]{40}|[a-f0-9]{64})$/.exec(version);
  if (!match) return undefined;
  return match[1]!.length === 64 ? "sha256" : "sha1";
}

function detectLineEnding(raw: string): RunTextLineEnding {
  let hasCrLf = false;
  let hasLf = false;
  let hasCr = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 13) {
      if (raw.charCodeAt(i + 1) === 10) {
        hasCrLf = true;
        i++;
      } else {
        hasCr = true;
      }
    } else if (code === 10) {
      hasLf = true;
    }
    if ((hasCrLf ? 1 : 0) + (hasLf ? 1 : 0) + (hasCr ? 1 : 0) > 1) return "mixed";
  }
  if (hasCrLf) return "crlf";
  if (hasLf) return "lf";
  if (hasCr) return "cr";
  return "none";
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function readVerifiedWorkspaceFile(
  root: CapturedWorkspaceRoot,
  diskPath: string,
  options: { maxBytes?: number; expectedVersion?: string; gitHash?: "sha1" | "sha256" } = {},
) {
  const result = await readWorkspaceFile(root, diskPath, options.maxBytes ?? MAX_RUN_TEXT_FILE_BYTES);
  if (!result.ok || options.expectedVersion === undefined) return result;
  const gitHash = options.gitHash ?? inferGitHashFromVersion(options.expectedVersion);
  if (computeRunFileFingerprint(result.data, gitHash) !== options.expectedVersion) {
    return { ok: false, reason: "diff_unavailable" } as const;
  }
  return result;
}

export function decodeRunTextDetailed(data: Buffer): RunTextDecodeResult {
  if (data.length > MAX_RUN_TEXT_FILE_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  // UTF-16LE BOM
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    try {
      const raw = utf16le.decode(data.subarray(2));
      return { ok: true, text: normalizeLineEndings(raw), encoding: "utf-16le", lineEnding: detectLineEnding(raw) };
    } catch {
      return { ok: false, reason: "binary" };
    }
  }
  // UTF-16BE BOM
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    try {
      const raw = utf16be.decode(data.subarray(2));
      return { ok: true, text: normalizeLineEndings(raw), encoding: "utf-16be", lineEnding: detectLineEnding(raw) };
    } catch {
      return { ok: false, reason: "binary" };
    }
  }
  if (data.includes(0)) {
    return { ok: false, reason: "binary" };
  }
  const hasUtf8Bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const payload = hasUtf8Bom ? data.subarray(3) : data;
  try {
    const raw = utf8.decode(payload);
    return {
      ok: true,
      text: normalizeLineEndings(raw),
      encoding: hasUtf8Bom ? "utf-8-bom" : "utf-8",
      lineEnding: detectLineEnding(raw),
    };
  } catch {
    return { ok: false, reason: "diff_unavailable" };
  }
}

export function decodeRunText(data: Buffer): string | undefined {
  const decoded = decodeRunTextDetailed(data);
  return decoded.ok ? decoded.text : undefined;
}

export async function readRunTextDetailed(
  root: CapturedWorkspaceRoot,
  version: string | undefined,
  captured: DecodedRunText | string | undefined,
  diskPath?: string,
  gitHash?: "sha1" | "sha256",
): Promise<RunTextDecodeResult> {
  if (!version || version === "missing") {
    return { ok: true, text: "", encoding: "utf-8", lineEnding: "none" };
  }
  if (captured !== undefined) {
    if (typeof captured === "string") {
      return { ok: true, text: captured, encoding: "utf-8", lineEnding: detectLineEnding(captured) };
    }
    return { ok: true, ...captured };
  }

  if (version.startsWith("metadata:")) {
    const size = Number(version.split(":")[1]);
    if (Number.isFinite(size) && size > MAX_RUN_TEXT_FILE_BYTES) {
      return { ok: false, reason: "too_large" };
    }
    return { ok: false, reason: "diff_unavailable" };
  }

  const blob = /^git:([a-f0-9]{40}|[a-f0-9]{64})$/.exec(version)?.[1];
  if (blob && await workspaceRootIsCurrent(root)) {
    try {
      const { stdout } = await execFileAsync("git", [...captureGitArgs(root.path), "cat-file", "blob", blob], {
        encoding: "buffer",
        maxBuffer: MAX_RUN_TEXT_FILE_BYTES + 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      });
      if (computeRunFileFingerprint(stdout, inferGitHashFromVersion(version)) === version) {
        return decodeRunTextDetailed(stdout);
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return { ok: false, reason: "too_large" };
      }
      // Fall through to verified diskPath when version is an uncommitted working-tree hash.
    }
  }

  if (diskPath) {
    const verified = await readVerifiedWorkspaceFile(root, diskPath, {
      maxBytes: MAX_RUN_TEXT_FILE_BYTES,
      expectedVersion: version,
      gitHash,
    });
    if (!verified.ok) return verified;
    return decodeRunTextDetailed(verified.data);
  }

  return { ok: false, reason: "diff_unavailable" };
}

export async function readRunText(
  root: CapturedWorkspaceRoot,
  version: string | undefined,
  captured: DecodedRunText | string | undefined,
  diskPath?: string,
  gitHash?: "sha1" | "sha256",
): Promise<string | undefined> {
  const result = await readRunTextDetailed(root, version, captured, diskPath, gitHash);
  return result.ok ? result.text : undefined;
}

function countUnifiedPatchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function buildRunFilePatch(
  root: string,
  file: string,
  before: string,
  after: string,
  kind: "added" | "modified" | "deleted",
): RunFilePatchDetail | undefined {
  if (before === after) return undefined;
  const name = path.relative(root, file).replace(/\\/g, "/").replace(/[\r\n\t]/g, "?");
  const oldName = kind === "added" ? "/dev/null" : "a/" + name;
  const newName = kind === "deleted" ? "/dev/null" : "b/" + name;
  const patch = structuredPatch(oldName, newName, before, after, undefined, undefined, {
    context: 3,
    timeout: JS_DIFF_TIMEOUT_MS,
    maxEditLength: JS_DIFF_MAX_EDIT_LENGTH,
  });
  if (!patch?.hunks.length) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { patch: formatPatch(patch), additions, deletions };
}

function rewriteGitNoIndexPatchHeaders(rawPatch: string, oldName: string, newName: string): string | undefined {
  const normalized = rawPatch.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const hunkStart = lines.findIndex((line) => line.startsWith("@@ "));
  if (hunkStart < 0) return undefined;
  return [`--- ${oldName}`, `+++ ${newName}`, ...lines.slice(hunkStart)].join("\n");
}

async function buildRunFilePatchViaGit(
  root: string,
  file: string,
  before: string,
  after: string,
  kind: "added" | "modified" | "deleted",
  timeoutMs = 5_000,
): Promise<RunFilePatchDetail | undefined> {
  let tempDir: string | undefined;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piora-run-diff-"));
    const beforePath = path.join(tempDir, "before");
    const afterPath = path.join(tempDir, "after");
    const writes = await Promise.allSettled([
      fs.writeFile(beforePath, before, "utf8"),
      fs.writeFile(afterPath, after, "utf8"),
    ]);
    if (writes.some((entry) => entry.status === "rejected")) {
      return undefined;
    }
    let rawPatch = "";
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", beforePath, afterPath],
        { encoding: "utf8", maxBuffer: MAX_RUN_PATCH_BYTES, timeout: Math.max(500, timeoutMs), windowsHide: true },
      );
      rawPatch = stdout;
    } catch (error) {
      const diffError = error as { code?: number | string; stdout?: unknown };
      // `git diff --no-index` exits with code 1 when files differ.
      if (diffError.code === 1 && typeof diffError.stdout === "string") {
        rawPatch = diffError.stdout;
      } else {
        return undefined;
      }
    }
    const name = path.relative(root, file).replace(/\\/g, "/").replace(/[\r\n\t]/g, "?");
    const oldName = kind === "added" ? "/dev/null" : "a/" + name;
    const newName = kind === "deleted" ? "/dev/null" : "b/" + name;
    const patch = rewriteGitNoIndexPatchHeaders(rawPatch, oldName, newName);
    if (!patch) return undefined;
    const { additions, deletions } = countUnifiedPatchStats(patch);
    return { patch, additions, deletions };
  } catch {
    return undefined;
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch((error) => {
        console.warn("[piora-run-diff] failed to clean temporary diff directory", { tempDir, error: String(error) });
      });
    }
  }
}

export async function buildRunFilePatchAsync(
  root: string,
  file: string,
  before: DecodedRunText | string,
  after: DecodedRunText | string,
  kind: "added" | "modified" | "deleted",
  remainingTimeMs?: number,
): Promise<{ detail?: RunFilePatchDetail; unavailableReason?: RunPatchUnavailableReason }> {
  const beforeText = typeof before === "string" ? before : before.text;
  const afterText = typeof after === "string" ? after : after.text;
  if (beforeText === afterText) {
    if (typeof before !== "string" && typeof after !== "string") {
      if (before.encoding !== after.encoding) {
        return { unavailableReason: "encoding_only" };
      }
      if (before.lineEnding !== after.lineEnding) {
        return { unavailableReason: "line_endings_only" };
      }
    }
    return { unavailableReason: "diff_unavailable" };
  }
  // Very large files diff much faster and never block the JS event loop via git.
  const combinedLength = beforeText.length + afterText.length;
  if (combinedLength <= 256 * 1024) {
    const detail = buildRunFilePatch(root, file, beforeText, afterText, kind);
    if (detail) return { detail };
  }
  const gitTimeout = remainingTimeMs !== undefined ? Math.min(5_000, Math.max(500, remainingTimeMs)) : 5_000;
  const gitDetail = await buildRunFilePatchViaGit(root, file, beforeText, afterText, kind, gitTimeout);
  if (gitDetail) return { detail: gitDetail };
  if (combinedLength > 256 * 1024) {
    const fallbackDetail = buildRunFilePatch(root, file, beforeText, afterText, kind);
    if (fallbackDetail) return { detail: fallbackDetail };
  }
  return { unavailableReason: "diff_unavailable" };
}
