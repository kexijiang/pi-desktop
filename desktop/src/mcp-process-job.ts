import type * as Koffi from "koffi" with { "resolution-mode": "import" };

const windowsJobKey = Symbol.for("piora.native-mcp.windows-job");
const KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE_AND_SET_QUOTA = 0x0001 | 0x0100;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
interface McpProcessJob { attach(pid: number): void; close(): void; }

function createJobFactory() {
  // The desktop already ships the platform binding used by its clipboard.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi: typeof Koffi = require("koffi");
  const kernel = koffi.load("kernel32.dll");
  const createJob = kernel.func("void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)");
  const openProcess = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const basicLimits = koffi.struct({
    perProcessTime: "int64_t", perJobTime: "int64_t", flags: "uint32_t", minWorkingSet: "size_t", maxWorkingSet: "size_t",
    activeProcesses: "uint32_t", affinity: "uintptr_t", priorityClass: "uint32_t", schedulingClass: "uint32_t",
  });
  const ioCounters = koffi.array("uint64_t", 6);
  const extendedLimits = koffi.struct({
    basicLimits, ioCounters, processMemory: "size_t", jobMemory: "size_t", peakProcessMemory: "size_t", peakJobMemory: "size_t",
  });
  const setInformation = kernel.func("int __stdcall SetInformationJobObject(void *job, int informationClass, const void *info, uint32_t size)");
  const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
  limits.writeUInt32LE(KILL_ON_JOB_CLOSE, koffi.offsetof(basicLimits, "flags"));

  return (): McpProcessJob => {
    const job = createJob(null, null);
    if (!job) throw new Error(`Could not create an MCP process job (${lastError()})`);
    try {
      if (!setInformation(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length)) {
        throw new Error(`Could not configure an MCP process job (${lastError()})`);
      }
    } catch (error) {
      close(job);
      throw error;
    }
    let open = true;
    return {
      attach(pid: number) {
        const child = openProcess(PROCESS_TERMINATE_AND_SET_QUOTA, 0, pid);
        if (!child) throw new Error(`Could not open the MCP server process (${lastError()})`);
        try {
          if (!assign(job, child)) throw new Error(`Could not take ownership of the MCP server process (${lastError()})`);
        } finally { close(child); }
      },
      close() {
        if (!open) return;
        open = false;
        close(job);
      },
    };
  };
}

export function installWindowsMcpProcessJobs(): void {
  if (process.platform !== "win32") return;
  const host = globalThis as typeof globalThis & { [windowsJobKey]?: () => McpProcessJob };
  let factory: ReturnType<typeof createJobFactory> | undefined;
  host[windowsJobKey] ??= () => (factory ??= createJobFactory())();
}
