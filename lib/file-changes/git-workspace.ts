import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pinWorkspaceRoot, type CapturedWorkspaceRoot } from "./workspace-file";

const execFileAsync = promisify(execFile);

export function captureGitArgs(root: string): string[] {
  return ["--no-optional-locks", "--no-replace-objects", "-C", root,
    "--git-dir=.git", "--work-tree=.", "-c", "core.fsmonitor=false"];
}

/** A real ancestor containing a checkout marker determines the capture scope. */
export async function findGitCaptureRoot(cwd: CapturedWorkspaceRoot): Promise<CapturedWorkspaceRoot | null> {
  let directory = cwd.path;
  while (true) {
    try {
      const marker = await fs.lstat(path.join(directory, ".git"));
      if (!marker.isDirectory() && !marker.isFile()) return null;
      const root = directory === cwd.path ? cwd : await pinWorkspaceRoot(directory);
      if (root?.path !== directory) return null;
      const { stdout } = await execFileAsync("git", [
        "-C", root.path, "rev-parse", "--show-toplevel",
      ], { timeout: 8_000, windowsHide: true });
      const reported = stdout.replace(/\r?\n$/, "");
      return path.isAbsolute(reported) && await fs.realpath(reported) === root.path ? root : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
