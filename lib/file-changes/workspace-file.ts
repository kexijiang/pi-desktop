import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface CapturedWorkspaceRoot {
  path: string;
  identity: string;
}

interface WorkspaceHandleInfo extends CapturedWorkspaceRoot {
  revision: string;
  size: number;
}

export interface WorkspaceHandle {
  inspect(): Promise<WorkspaceHandleInfo | null>;
  read(maxBytes: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

type WorkspaceFileRead =
  | { ok: true; data: Buffer }
  | { ok: false; reason: "diff_unavailable" }
  | { ok: false; reason: "too_large"; size: number; revision: string };

/** Compare canonical paths with their filesystem casing, including on Windows. */
export function workspaceContainsPath(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(prefix);
}

let darwinFcntl: Promise<(fd: number, buffer: Buffer) => number> | undefined;

async function posixHandlePath(fd: number): Promise<string | null> {
  if (process.platform === "linux") return fs.readlink("/proc/self/fd/" + fd);
  if (process.platform === "darwin") {
    darwinFcntl ??= import("koffi").then(({ load }) => {
      const fcntl = load("/usr/lib/libSystem.B.dylib").func("int fcntl(int fd, int command, ...)");
      // F_GETPATH returns the path of the open file into a MAXPATHLEN buffer.
      return (descriptor, output) => fcntl(descriptor, 50, "void *", output) as number;
    });
    const output = Buffer.alloc(1024);
    if ((await darwinFcntl)(fd, output) === 0) {
      const terminator = output.indexOf(0);
      if (terminator > 0) return output.toString("utf8", 0, terminator);
    }
  }
  return null;
}

async function openWorkspaceHandle(target: string, directory: boolean): Promise<WorkspaceHandle | null> {
  if (process.platform === "win32") {
    const { openWindowsWorkspaceHandle } = await import("./windows-workspace-handle");
    return openWindowsWorkspaceHandle(target, directory);
  }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (directory ? constants.O_DIRECTORY : 0));
  return {
    async inspect() {
      const stat = await handle.stat({ bigint: true });
      if (stat.ino === BigInt(0) || stat.nlink === BigInt(0) || (directory ? !stat.isDirectory() : !stat.isFile())) return null;
      const resolved = await posixHandlePath(handle.fd);
      if (!resolved || !path.isAbsolute(resolved)) return null;
      return {
        path: resolved,
        identity: [stat.dev, stat.ino, stat.birthtimeNs].join(":"),
        revision: [stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
        size: Number(stat.size),
      };
    },
    async read(maxBytes) {
      const output = Buffer.allocUnsafe(maxBytes);
      let offset = 0;
      while (offset < maxBytes) {
        const { bytesRead } = await handle.read(output, offset, maxBytes - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return output.subarray(0, offset);
    },
    close: () => handle.close(),
  };
}

function matchesRoot(root: CapturedWorkspaceRoot, current: WorkspaceHandleInfo | null | undefined): boolean {
  return current?.path === root.path && current.identity === root.identity;
}

export async function pinWorkspaceRoot(directory: string): Promise<CapturedWorkspaceRoot | null> {
  let handle: WorkspaceHandle | null | undefined;
  try {
    const resolved = await fs.realpath(directory);
    handle = await openWorkspaceHandle(resolved, true);
    const info = await handle?.inspect();
    return info?.path === resolved ? { path: info.path, identity: info.identity } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function workspaceRootIsCurrent(root: CapturedWorkspaceRoot): Promise<boolean> {
  let handle: WorkspaceHandle | null | undefined;
  try {
    handle = await openWorkspaceHandle(root.path, true);
    return matchesRoot(root, await handle?.inspect());
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Authorize the actual opened file before reading. Looking up the input path
 * again would only validate the directory entries at a different instant.
 */
export async function readWorkspaceFile(
  root: CapturedWorkspaceRoot,
  target: string,
  maxBytes: number,
): Promise<WorkspaceFileRead> {
  const unavailable = { ok: false, reason: "diff_unavailable" } as const;
  const filePath = path.resolve(target);
  if (!workspaceContainsPath(root.path, filePath) || filePath === root.path) return unavailable;

  let directory: WorkspaceHandle | null | undefined;
  let file: WorkspaceHandle | null | undefined;
  try {
    directory = await openWorkspaceHandle(root.path, true);
    if (!directory || !matchesRoot(root, await directory.inspect())) return unavailable;
    file = await openWorkspaceHandle(filePath, false);
    if (!file) return unavailable;

    const before = await file.inspect();
    if (!before || !workspaceContainsPath(root.path, before.path) || !matchesRoot(root, await directory.inspect())) {
      return unavailable;
    }
    if (before.size > maxBytes) {
      return { ok: false, reason: "too_large", size: before.size, revision: before.revision };
    }

    const data = before.size === 0 ? Buffer.alloc(0) : await file.read(before.size + 1);
    const after = await file.inspect();
    if (!data || data.length !== before.size || after?.path !== before.path || after.identity !== before.identity
      || after.revision !== before.revision || !matchesRoot(root, await directory.inspect())) {
      return unavailable;
    }
    return { ok: true, data };
  } catch {
    return unavailable;
  } finally {
    await file?.close().catch(() => {});
    await directory?.close().catch(() => {});
  }
}
