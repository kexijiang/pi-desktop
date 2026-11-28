import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  beginPromptFileChanges,
  finishPromptFileChanges,
  preparePromptFileChanges,
  recordPromptFileTouch,
} = await jiti.import("./prompt-file-changes.ts");
const { readRunTextDetailed } = await jiti.import("./file-changes/run-patch.ts");
const { pinWorkspaceRoot } = await jiti.import("./file-changes/workspace-file.ts");
const { RunPatchCache } = await jiti.import("./file-changes/run-patch-cache.ts");

async function readPromptFileChanges(sessionId) {
  return (await preparePromptFileChanges(sessionId))?.read();
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function removeTestDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true });
}

test("records only net changes during a run, including pre-existing edits and cancellations", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-files-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const repo = path.join(temporary, "git-workspace");
    await mkdir(repo);
    git(repo, "init", "-q");
    await writeFile(path.join(repo, "existing.md"), "original\n");
    await writeFile(path.join(repo, "deleted.txt"), "delete me\n");
    await writeFile(path.join(repo, "clean.txt"), "clean\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Piora Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline");

    // An older uncommitted edit is part of the baseline, not this run.
    await writeFile(path.join(repo, "existing.md"), "already dirty\n");
    const identity = { sessionId: "git-session", runId: "run-one" };
    const capture = beginPromptFileChanges(identity, repo);
    await capture.initial;
    await writeFile(path.join(repo, "existing.md"), "changed again\n");
    await writeFile(path.join(repo, "clean.txt"), "changed\n");
    await rm(path.join(repo, "deleted.txt"));
    await writeFile(path.join(repo, "new.txt"), "new\n");
    const result = await finishPromptFileChanges(capture, "aborted");
    assert.equal(result.status, "aborted");
    assert.equal(result.partial, false);
    assert.deepEqual(result.files.map(({ path: file, kind }) => [path.basename(file), kind]).sort(), [
      ["clean.txt", "modified"],
      ["deleted.txt", "deleted"], ["existing.md", "modified"], ["new.txt", "added"],
    ]);
    const byName = new Map(result.files.map(file => [path.basename(file.path), file]));
    assert.deepEqual([...byName].map(([name, file]) => [name, file.additions, file.deletions]), [
      ["clean.txt", 1, 1], ["deleted.txt", 0, 1], ["existing.md", 1, 1], ["new.txt", 1, 0],
    ]);
    assert.match(byName.get("existing.md").patch, /-already dirty\n\+changed again/);
    assert.doesNotMatch(byName.get("existing.md").patch, /^-original$/m);
    assert.match(byName.get("deleted.txt").patch, /\+\+\+ \/dev\/null/);
    assert.ok(byName.get("new.txt").patchRevision);
    assert.deepEqual(await readPromptFileChanges(identity.sessionId), result);
    const key = createHash("sha256").update(identity.sessionId).digest("hex");
    const saved = JSON.parse(await readFile(path.join(temporary, "agent", "piora", "prompt-file-changes", `${key}.json`), "utf8"));
    assert.deepEqual(saved, result);

    const unchanged = beginPromptFileChanges({ sessionId: "git-session", runId: "run-two" }, repo);
    await unchanged.initial;
    const pendingRead = await preparePromptFileChanges("git-session");
    await writeFile(path.join(repo, "existing.md"), "temporary\n");
    await writeFile(path.join(repo, "existing.md"), "changed again\n");
    const noChange = await finishPromptFileChanges(unchanged, "complete");
    assert.deepEqual(noChange.files, []);
    assert.equal(await pendingRead.read(), null);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-files-");
  }
});

test("tracks non-Git workspaces and marks incomplete scans", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-plain-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const workspace = path.join(temporary, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "notes.md"), "old\n");
    const capture = beginPromptFileChanges({ sessionId: "plain-session", runId: "run-one" }, workspace);
    await capture.initial;
    assert.equal((await readPromptFileChanges("plain-session"))?.status, "running");
    await writeFile(path.join(workspace, "notes.md"), "new\n");
    const result = await finishPromptFileChanges(capture, "complete");
    assert.deepEqual(result.files.map(({ path: file, kind }) => [path.basename(file), kind]), [["notes.md", "modified"]]);
    assert.equal((await readPromptFileChanges("plain-session"))?.status, "complete");

    let deepDirectory = workspace;
    for (let index = 0; index < 10; index++) {
      deepDirectory = path.join(deepDirectory, `level-${index}`);
      await mkdir(deepDirectory);
    }
    const incomplete = beginPromptFileChanges({ sessionId: "plain-session", runId: "run-two" }, workspace);
    await incomplete.initial;
    assert.equal((await finishPromptFileChanges(incomplete, "complete")).partial, true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-plain-");
  }
});

test("reports live edits while running and tracks touched gitignored files", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-live-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const repo = path.join(temporary, "git-workspace");
    await mkdir(repo);
    git(repo, "init", "-q");
    await mkdir(path.join(repo, "ignored-dir"));
    await writeFile(path.join(repo, ".gitignore"), "ignored-dir/\n");
    await writeFile(path.join(repo, "tracked.txt"), "before\n");
    await writeFile(path.join(repo, "ignored-dir", "notes.md"), "ignored-before\n");
    git(repo, "add", ".gitignore", "tracked.txt");
    git(repo, "-c", "user.name=Piora Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");

    const capture = beginPromptFileChanges({ sessionId: "live-session", runId: "run-live" }, repo);
    await capture.initial;

    await Promise.all([
      recordPromptFileTouch("live-session", "ignored-dir/notes.md", repo),
      recordPromptFileTouch("live-session", "ignored-dir/notes.md", repo),
    ]);
    await writeFile(path.join(repo, "ignored-dir", "notes.md"), "ignored-after\n");
    await writeFile(path.join(repo, "tracked.txt"), "after\n");

    const live = await readPromptFileChanges("live-session");
    assert.equal(live?.status, "running");
    assert.deepEqual(
      live?.files.map(({ path: file, kind }) => [path.basename(file), kind]),
      [["notes.md", "modified"], ["tracked.txt", "modified"]],
    );
    assert.match(live.files[0].patch, /-ignored-before\n\+ignored-after/);
    assert.match(live.files[1].patch, /-before\n\+after/);

    const finished = await finishPromptFileChanges(capture, "complete");
    assert.equal(finished.status, "complete");
    assert.deepEqual(
      finished.files.map(({ path: file, kind }) => [path.basename(file), kind]),
      [["notes.md", "modified"], ["tracked.txt", "modified"]],
    );
    assert.deepEqual(finished.files, live.files, "settlement preserves the same before/after changes");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-live-");
  }
});

test("builds line-level diffs for >96KB files and reports explicit reasons for oversized, CRLF-only, or encoding-only files", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-large-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const repo = path.join(temporary, "git-workspace");
    await mkdir(repo);
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    const largeLines = Array.from({ length: 3000 }, (_, i) => `export const line_${i} = "value_${i}_${"a".repeat(30)}";`);
    const largeBefore = `${largeLines.join("\n")}\n`;
    assert.ok(Buffer.byteLength(largeBefore) > 150 * 1024, "fixture must exceed legacy 96KB limit");
    await writeFile(path.join(repo, "large.ts"), largeBefore);
    await writeFile(path.join(repo, "crlf.txt"), "line one\nline two\n");
    await writeFile(path.join(repo, "bom.txt"), "same text\n", "utf8");
    await writeFile(path.join(repo, "huge.txt"), "h".repeat(1200 * 1024));
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Piora Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");

    const capture = beginPromptFileChanges({ sessionId: "large-session", runId: "run-large" }, repo);
    await capture.initial;

    const largeAfterLines = [...largeLines];
    largeAfterLines[1500] = 'export const line_1500 = "updated_value_1500";';
    await writeFile(path.join(repo, "large.ts"), `${largeAfterLines.join("\n")}\n`);
    await writeFile(path.join(repo, "crlf.txt"), "line one\r\nline two\r\n");
    await writeFile(path.join(repo, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("same text\n", "utf8")]));
    await writeFile(path.join(repo, "huge.txt"), `${"h".repeat(1200 * 1024)}x`);

    const finished = await finishPromptFileChanges(capture, "complete");
    const byName = new Map(finished.files.map((file) => [path.basename(file.path), file]));

    const largeEntry = byName.get("large.ts");
    assert.ok(largeEntry?.patch, "files larger than 96KB must still produce a line-level patch");
    assert.equal(largeEntry.additions, 1);
    assert.equal(largeEntry.deletions, 1);
    assert.match(largeEntry.patch, /updated_value_1500/);

    const hugeEntry = byName.get("huge.txt");
    assert.equal(hugeEntry?.patch, undefined);
    assert.equal(hugeEntry?.unavailableReason, "too_large");

    const crlfEntry = byName.get("crlf.txt");
    assert.ok(crlfEntry, "CRLF-only file change must be deterministically captured with core.autocrlf=false");
    assert.equal(crlfEntry.patch, undefined);
    assert.equal(crlfEntry.unavailableReason, "line_endings_only");

    const bomEntry = byName.get("bom.txt");
    assert.ok(bomEntry, "UTF-8 BOM addition must be recorded");
    assert.equal(bomEntry.patch, undefined);
    assert.equal(bomEntry.unavailableReason, "encoding_only");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-large-");
  }
});

test("disk fallback rejects symlink/junction escape outside capture root and verifies fingerprints", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-security-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const workspace = path.join(temporary, "workspace");
    const outside = path.join(temporary, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    const capturedRoot = await pinWorkspaceRoot(workspace);
    assert.ok(capturedRoot);
    const secretFile = path.join(outside, "secret.txt");
    await writeFile(secretFile, "TOP_SECRET_OUTSIDE_WORKSPACE\n");

    const linkedDir = path.join(capturedRoot.path, "linked-dir");
    await symlink(outside, linkedDir, process.platform === "win32" ? "junction" : "dir");
    const escapedPath = path.join(linkedDir, "secret.txt");
    const secretHash = createHash("sha256").update("TOP_SECRET_OUTSIDE_WORKSPACE\n").digest("hex");

    // Disk fallback must refuse files reached through a parent symlink/junction outside root.
    const escapedRead = await readRunTextDetailed(capturedRoot, secretHash, undefined, escapedPath);
    assert.equal(escapedRead.ok, false);
    assert.equal(escapedRead.reason, "diff_unavailable");

    // Inside workspace, mismatched fingerprint must be rejected rather than reading stale/newer bytes.
    const insideFile = path.join(capturedRoot.path, "inside.txt");
    await writeFile(insideFile, "version-two\n");
    const oldHash = createHash("sha256").update("version-one\n").digest("hex");
    const mismatched = await readRunTextDetailed(capturedRoot, oldHash, undefined, insideFile);
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.reason, "diff_unavailable");

    const matchingHash = createHash("sha256").update("version-two\n").digest("hex");
    const matched = await readRunTextDetailed(capturedRoot, matchingHash, undefined, insideFile);
    assert.equal(matched.ok, true);
    assert.equal(matched.text, "version-two\n");

    // A new directory at the same path starts a different authorization scope.
    await rename(workspace, path.join(temporary, "moved-workspace"));
    await mkdir(workspace);
    await writeFile(insideFile, "version-two\n");
    assert.deepEqual(await readRunTextDetailed(capturedRoot, matchingHash, undefined, insideFile), {
      ok: false,
      reason: "diff_unavailable",
    });
    const freshRoot = await pinWorkspaceRoot(workspace);
    assert.ok(freshRoot);
    assert.notEqual(freshRoot.identity, capturedRoot.identity);
    assert.equal((await readRunTextDetailed(freshRoot, matchingHash, undefined, insideFile)).text, "version-two\n");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-security-");
  }
});

test("captures verified Git top-level root when started from a Git subdirectory", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-subdir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const repo = path.join(temporary, "repo");
    const subdir = path.join(repo, "packages", "app");
    await mkdir(subdir, { recursive: true });
    git(repo, "init", "-q");
    await writeFile(path.join(repo, "root-file.txt"), "before\n");
    await writeFile(path.join(subdir, "child.txt"), "child\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Piora Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");

    const capture = beginPromptFileChanges({ sessionId: "subdir-session", runId: "run-subdir" }, subdir);
    await capture.initial;
    await writeFile(path.join(repo, "root-file.txt"), "after\n");
    const finished = await finishPromptFileChanges(capture, "complete");

    assert.equal(finished.captureRoot, await realpath(repo));
    assert.ok(finished.captureRootIdentity);
    assert.equal(finished.files.length, 1);
    assert.equal(path.basename(finished.files[0].path), "root-file.txt");
    assert.match(finished.files[0].patch, /-before\n\+after/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-subdir-");
  }
});

test("uses the linked checkout as the run scope while reading its shared Git objects", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "piora-run-worktree-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  try {
    const repo = path.join(temporary, "main");
    const worktree = path.join(temporary, "linked");
    await mkdir(repo);
    git(repo, "init", "-q");
    await writeFile(path.join(repo, "tracked.txt"), "before\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Piora Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
    git(repo, "worktree", "add", "--quiet", "--detach", worktree);

    const capture = beginPromptFileChanges({ sessionId: "linked-session", runId: "run-linked" }, worktree);
    await capture.initial;
    await writeFile(path.join(worktree, "tracked.txt"), "after\n");
    const finished = await finishPromptFileChanges(capture, "complete");
    assert.equal(finished.captureRoot, await realpath(worktree));
    assert.equal(finished.files.length, 1);
    assert.match(finished.files[0].patch, /-before\n\+after/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeTestDirectory(temporary, "piora-run-worktree-");
  }
});

test("run patch cache evicts older file versions and enforces run-wide limits", () => {
  const cache = new RunPatchCache(6, 2);
  const patch = (text) => ({ patch: text, patchRevision: text, additions: 1, deletions: 0 });
  cache.set("a", "1", patch("aa"));
  cache.set("a", "2", patch("aaa"));
  cache.set("b", "1", patch("bbb"));
  assert.deepEqual(cache.get("a", "2"), patch("aaa"));
  cache.set("c", "1", patch("cccc"));
  assert.equal(cache.get("a", "2"), undefined);
  assert.equal(cache.get("b", "1"), undefined);
  assert.deepEqual(cache.get("c", "1"), patch("cccc"));
  cache.set("d", "1", patch("d"));
  cache.set("e", "1", patch("e"));
  assert.equal(cache.get("c", "1"), undefined);
  assert.deepEqual(cache.get("d", "1"), patch("d"));
  assert.deepEqual(cache.get("e", "1"), patch("e"));
  cache.set("d", "2", patch("dd"));
  assert.equal(cache.get("d", "3"), undefined);
  assert.equal(cache.get("d", "2"), undefined);
});
