import { execFileSync } from "node:child_process";
import { StdioTransport } from "@earendil-works/pi-mcp";

const DEFAULT_MAX_STDIO_CONNECTIONS = 12;
const leasesKey = Symbol.for("piora.native-mcp.stdio-leases");
const windowsJobKey = Symbol.for("piora.native-mcp.windows-job");
const evictIdleKey = Symbol.for("piora.native-mcp.evict-idle-session");
const windowsFallbackPidsKey = Symbol.for("piora.native-mcp.windows-fallback-pids");
const windowsExitHookKey = Symbol.for("piora.native-mcp.windows-exit-hook");

interface McpProcessJob { attach(pid: number): void; close(): void; }
type EvictIdleSession = () => Promise<boolean>;

const host = globalThis as typeof globalThis & {
  [leasesKey]?: Set<StdioTransport>;
  [windowsJobKey]?: () => McpProcessJob;
  [evictIdleKey]?: EvictIdleSession;
  [windowsFallbackPidsKey]?: Set<number>;
  [windowsExitHookKey]?: boolean;
};

const leases = host[leasesKey] ??= new Set();
const windowsFallbackPids = host[windowsFallbackPidsKey] ??= new Set();

function maxStdioConnections(): number {
  const configured = Number(process.env.PIORA_MAX_MCP_STDIO_CONNECTIONS);
  if (Number.isSafeInteger(configured) && configured >= 1 && configured <= 200) return configured;
  return DEFAULT_MAX_STDIO_CONNECTIONS;
}

function ensureWindowsExitFallback(): void {
  if (process.platform !== "win32" || host[windowsExitHookKey]) return;
  host[windowsExitHookKey] = true;
  process.once("exit", () => {
    for (const pid of windowsFallbackPids) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 2_000,
        });
      } catch {
        // Process already exited or cannot be killed during shutdown.
      }
    }
    windowsFallbackPids.clear();
  });
}

export function registerIdleMcpSessionEvictor(evictor: EvictIdleSession): void {
  host[evictIdleKey] = evictor;
}

export class ManagedMcpStdioTransport extends StdioTransport {
  private closeJob?: () => void;
  private trackedPid?: number;
  private retirement?: Promise<void>;

  override async start(): Promise<void> {
    if (leases.has(this)) return super.start();
    const limit = maxStdioConnections();
    let evictionAttempts = 0;
    while (leases.size >= limit && host[evictIdleKey] && evictionAttempts < 6) {
      evictionAttempts += 1;
      const evicted = await host[evictIdleKey]().catch(() => false);
      if (!evicted) break;
    }
    if (leases.size >= limit) {
      throw new Error(`Piora has reached its ${limit} native MCP stdio connections. Close idle sessions or reconnect after a connection is released.`);
    }
    leases.add(this);
    this.onClose(() => this.release());
    try {
      const job = host[windowsJobKey]?.();
      this.closeJob = job?.close;
      // The SDK spawns synchronously before waiting for the child spawn event.
      // Allocate the job first so only the attachment remains after launch.
      const startup = super.start();
      void startup.catch(() => undefined);
      const pid = this.pid;
      if (pid !== undefined) {
        if (job) {
          try {
            job.attach(pid);
          } catch (attachError) {
            // If the child exited immediately on startup, let `await startup`
            // surface the real spawn/stderr error instead of masking it.
            console.warn("[pi-web:mcp] unable to attach MCP child to Windows job:", attachError instanceof Error ? attachError.message : attachError);
          }
        } else if (process.platform === "win32") {
          ensureWindowsExitFallback();
          this.trackedPid = pid;
          windowsFallbackPids.add(pid);
        }
      }
      await startup;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  override close(): Promise<void> {
    return this.retirement ??= this.stop();
  }

  private async stop(): Promise<void> {
    // Give servers their ordinary EOF shutdown. The job also handles a server
    // or wrapper that exited while one of its children still holds the pipes.
    const timer = this.closeJob ? setTimeout(() => this.closeJob?.(), 500) : undefined;
    try { await super.close(); }
    finally {
      clearTimeout(timer);
      this.release();
    }
  }

  private release(): void {
    this.closeJob?.();
    this.closeJob = undefined;
    if (this.trackedPid !== undefined) {
      windowsFallbackPids.delete(this.trackedPid);
      this.trackedPid = undefined;
    }
    leases.delete(this);
  }
}
