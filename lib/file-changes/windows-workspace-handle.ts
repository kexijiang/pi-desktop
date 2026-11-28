import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceHandle } from "./workspace-file";

type WindowsHandle = number | bigint;

const FILE_READ_ATTRIBUTES = 0x80;
const GENERIC_READ = 0x8000_0000;
const SHARE_READ_WRITE = 0x3;
const SHARE_DELETE = 0x4;
const OPEN_EXISTING = 3;
const BACKUP_SEMANTICS = 0x0200_0000;
const OPEN_REPARSE_POINT = 0x0020_0000;
const ATTRIBUTE_DIRECTORY = 0x10;
const ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_TYPE_DISK = 1;

async function loadBindings() {
  const { load } = await import("koffi");
  const kernel = load("kernel32.dll");
  return {
    open: promisify(kernel.func("intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, intptr_t template)").async),
    close: kernel.func("int __stdcall CloseHandle(intptr_t handle)"),
    type: kernel.func("uint32_t __stdcall GetFileType(intptr_t handle)"),
    info: promisify(kernel.func("int __stdcall GetFileInformationByHandle(intptr_t handle, void *info)").async),
    finalPath: promisify(kernel.func("uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t handle, void *output, uint32_t capacity, uint32_t flags)").async),
    read: promisify(kernel.func("int __stdcall ReadFile(intptr_t handle, void *output, uint32_t size, void *count, void *overlapped)").async),
  };
}

let bindings: ReturnType<typeof loadBindings> | undefined;

function fromWindowsHandlePath(value: string): string | null {
  if (value.startsWith("\\\\?\\UNC\\")) return "\\\\" + value.slice(8);
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) {
    return value[4]!.toUpperCase() + value.slice(5);
  }
  return null;
}

export async function openWindowsWorkspaceHandle(target: string, directory: boolean): Promise<WorkspaceHandle | null> {
  const api = await (bindings ??= loadBindings());
  const handle = await api.open(
    path.toNamespacedPath(target),
    directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
    directory ? SHARE_READ_WRITE : SHARE_READ_WRITE | SHARE_DELETE,
    null,
    OPEN_EXISTING,
    OPEN_REPARSE_POINT | (directory ? BACKUP_SEMANTICS : 0),
    0,
  ) as WindowsHandle;
  if (handle === -1 || handle === BigInt(-1)) return null;

  return {
    async inspect() {
      if (api.type(handle) !== FILE_TYPE_DISK) return null;
      // BY_HANDLE_FILE_INFORMATION is thirteen DWORDs, including three FILETIMEs.
      const info = Buffer.alloc(52);
      if (!await api.info(handle, info)) return null;
      const attributes = info.readUInt32LE(0);
      const isDirectory = Boolean(attributes & ATTRIBUTE_DIRECTORY);
      if (attributes & ATTRIBUTE_REPARSE_POINT || isDirectory !== directory) return null;

      let name = Buffer.alloc(1024);
      let length = await api.finalPath(handle, name, name.length / 2, 0) as number;
      if (length >= name.length / 2 && length <= 32_768) {
        name = Buffer.alloc(length * 2);
        length = await api.finalPath(handle, name, name.length / 2, 0) as number;
      }
      if (!length || length >= name.length / 2) return null;
      const resolved = fromWindowsHandlePath(name.toString("utf16le", 0, length * 2));
      if (!resolved) return null;

      const volume = info.readUInt32LE(28);
      const indexHigh = info.readUInt32LE(44);
      const indexLow = info.readUInt32LE(48);
      if (indexHigh === 0 && indexLow === 0) return null;
      const size = info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36);
      return {
        path: resolved,
        identity: [volume, indexHigh, indexLow, info.readBigUInt64LE(4)].join(":"),
        revision: [info.readBigUInt64LE(20), size].join(":"),
        size,
      };
    },
    async read(maxBytes) {
      const output = Buffer.allocUnsafe(maxBytes);
      const count = Buffer.alloc(4);
      if (!await api.read(handle, output, output.length, count, null)) return null;
      return output.subarray(0, count.readUInt32LE(0));
    },
    async close() { api.close(handle); },
  };
}
