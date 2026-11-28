import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { preparePromptFileChanges } from "@/lib/prompt-file-changes";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { workspaceContainsPath, workspaceRootIsCurrent } from "@/lib/file-changes/workspace-file";

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function nearestExistingPath(target: string): string | null {
  let probe = path.resolve(target);
  while (true) {
    try {
      lstatSync(probe);
      return probe;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

function physicalPath(target: string): string | null {
  try { return realpathSync.native(target); }
  catch { return null; }
}

function isRunFilePathAuthorized(target: string, roots: Set<string>): boolean {
  if (!isFilePathAllowed(target, roots)) return false;
  // Deleted files are scoped by their nearest remaining parent. For an existing
  // reparse point, resolve that entry itself, including its parent directories.
  const ancestor = nearestExistingPath(target);
  const realPath = ancestor && physicalPath(ancestor);
  return realPath !== null && [...roots].some((root) => workspaceContainsPath(root, realPath));
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const liveSession = getRpcSession(id);
  if (!liveSession?.isAlive() && !await resolveSessionPath(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const query = new URL(request.url).searchParams;
  const wantsDetail = query.has("path");
  const roots = new Set(await getAllowedFileRoots());
  if (liveSession?.isAlive() && liveSession.cwd) {
    roots.add(liveSession.cwd);
  }

  const unavailable = () => wantsDetail
    ? NextResponse.json({ error: "Run file not found" }, { status: 404 })
    : NextResponse.json(null);
  const denied = () => NextResponse.json({ error: "Access denied" }, { status: 403 });
  const prepared = await preparePromptFileChanges(id);
  if (!prepared) return unavailable();

  const { scope } = prepared;
  if (typeof scope.cwd !== "string" || !scope.cwd) return denied();
  const cwdAuthorized = isExistingFilePathAllowed(scope.cwd, roots);
  if (!cwdAuthorized && (wantsDetail || scope.status === "running" || !isFilePathAllowed(scope.cwd, roots))) {
    return denied();
  }
  const realCwd = physicalPath(scope.cwd);
  const captureRoots = new Set<string>();
  if (scope.captureRoot && scope.captureRootIdentity) {
    const captured = { path: scope.captureRoot, identity: scope.captureRootIdentity };
    if (!realCwd || !workspaceContainsPath(captured.path, realCwd) || !await workspaceRootIsCurrent(captured)) {
      return denied();
    }
    captureRoots.add(captured.path);
  } else if (wantsDetail && realCwd) {
    // Older records can use existing allowed project roots which enclose their
    // cwd. Their saved path does not authorize a new root.
    captureRoots.add(realCwd);
    for (const root of roots) {
      const physicalRoot = physicalPath(root);
      if (physicalRoot && workspaceContainsPath(physicalRoot, realCwd)) captureRoots.add(physicalRoot);
    }
  }

  const requestedRunId = query.get("runId");
  if (wantsDetail && requestedRunId && scope.runId !== requestedRunId) {
    return NextResponse.json(
      { error: "Run superseded", code: "RUN_SUPERSEDED", currentRunId: scope.runId },
      { status: 409 },
    );
  }

  const changes = await prepared.read();
  if (!changes) return unavailable();
  if (!wantsDetail) {
    return NextResponse.json({
      sessionId: changes.sessionId,
      runId: changes.runId,
      cwd: changes.cwd,
      captureRoot: changes.captureRoot,
      startedAt: changes.startedAt,
      finishedAt: changes.finishedAt,
      status: changes.status,
      partial: changes.partial,
      files: changes.files.map(({ path: filePath, kind, additions, deletions, patchRevision, unavailableReason }) => ({
        path: filePath,
        kind,
        additions,
        deletions,
        patchRevision,
        ...(unavailableReason ? { unavailableReason } : {}),
      })),
    });
  }

  const requestedPath = query.get("path");
  const file = requestedPath
    ? changes.files.find((entry) => entry.path === requestedPath)
      ?? changes.files.find((entry) => samePath(entry.path, requestedPath))
    : undefined;
  if (!file) return unavailable();
  if (!isRunFilePathAuthorized(file.path, captureRoots)) return denied();
  return NextResponse.json({
    patch: file.patch ?? null,
    ...(file.unavailableReason ? { unavailableReason: file.unavailableReason } : {}),
  });
}
