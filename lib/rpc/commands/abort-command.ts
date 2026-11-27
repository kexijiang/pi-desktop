import { randomUUID } from "node:crypto";
import { finishPromptRun } from "../../prompt-run-registry";
import { notifyRunningChange } from "../../rpc-running-status";
import type { SessionRpcCommand } from "../../session-command-policy";
import { findWorkflowRuntime } from "../../workflow-runtime";
import { formatTelemetryModel, logRunEvent, type RunTerminationReason } from "../run-telemetry";
import type { RpcCommandHost } from "./host";

function toTelemetryAbortReason(raw: string): RunTerminationReason {
  switch (raw) {
    case "user_abort":
    case "tool_review_denied":
    case "workflow_abort":
    case "wrapper_destroyed":
    case "idle_timeout":
    case "restart_extensions":
    case "fork":
    case "file_mutation":
    case "process_shutdown":
    case "lru_eviction":
    case "process_interrupted":
      return raw;
    default:
      return "user_abort";
  }
}

export async function handleAbortCommand(host: RpcCommandHost, command?: SessionRpcCommand) {
  const abortReason = typeof command?.abortReason === "string" && command.abortReason.trim()
    ? command.abortReason.trim()
    : "user_abort";
  const abortDetail = typeof command?.abortDetail === "string" && command.abortDetail.trim()
    ? command.abortDetail.trim()
    : undefined;
  const subagentCleanup = host.subagents?.stopAll();
  if (host.hasPermissionParent) host.abortSubagentUi();
  host.permissions.invalidateParent();
  findWorkflowRuntime(host.sessionId)?.onAbort();
  host.permissions.cancel();
  const receipt = () => ({
    accepted: true,
    ...(host.abortedQueuedMessages ? { queuedMessages: host.abortedQueuedMessages } : {}),
  });
  // Keep the handoff available when the client retries a lost stop reply.
  // A new prompt clears it, so a later stop cannot replay the previous queue.
  if (host.stopping || (!host.isRunning() && host.abortedQueuedMessages)) {
    await host.stoppedInputRecovery;
    return receipt();
  }
  const promptRun = host.activePromptRun;
  host.lastAbortReason = abortReason;
  host.lastAbortDetail = abortDetail;
  if (host.isRunning() || promptRun) {
    logRunEvent(abortReason === "user_abort" ? "info" : "warn", {
      sessionId: host.sessionId,
      runId: promptRun?.runId,
      commandId: host.activeCommandId,
      reason: toTelemetryAbortReason(abortReason),
      model: formatTelemetryModel(host.inner.model),
      errorMessage: abortDetail,
    });
  }
  host.abortGeneration += 1;
  // Claim all unconsumed admissions synchronously, including input hooks
  // which have not reached the SDK queue yet. Persist before acknowledging.
  const stoppedReceipts = [...host.queuedInputReceipts.entries()];
  const recoveryTasks = stoppedReceipts.map(([, queuedReceipt]) => queuedReceipt.cancelled());
  host.stoppedInputRecovery = Promise.all(recoveryTasks).then(() => undefined);
  host.stopping = true;
  host.statusPhaseKind = "stopping";
  host.statusPhaseStartedAt = Date.now();
  notifyRunningChange();

  // AgentSession.abort() signals its AbortController synchronously, then
  // waits for the model transport and all event listeners to become idle.
  // Do not hold the stop request open for that potentially slow cleanup:
  // the UI can settle immediately while the wrapper remains `stopping`
  // until the real runtime has finished unwinding.
  const signal = (cancel: () => unknown) => {
    try { return Promise.resolve(cancel()); }
    catch (error) { return Promise.reject(error); }
  };
  const abortTask = signal(() => host.inner.abort());
  const compactionTask = signal(() => host.inner.abortCompaction());
  const bashTask = signal(() => host.inner.abortBash());
  const queueTask = signal(() => {
    const queued = host.inner.clearQueue();
    host.abortedQueuedMessages = queued.steering.length || queued.followUp.length ? { id: randomUUID(), ...queued } : undefined;
    host.emit({ type: "queue_update", steering: [], followUp: [] });
  });
  const uiTasks = host.uiBridge.createAbortCancelTasks(signal);
  const cleanupTask = finishPromptRun(promptRun, "abort");
  if (host.activePromptRun?.runId === promptRun?.runId) host.activePromptRun = undefined;

  host.abortCleanupTask = Promise.allSettled([
    abortTask,
    compactionTask,
    bashTask,
    queueTask,
    cleanupTask,
    subagentCleanup,
    ...uiTasks,
    ...host.promptTasks,
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[pi-web] active run abort cleanup failed:", result.reason instanceof Error ? result.reason.message : result.reason);
      }
    }
  }).finally(() => {
    // A queue drain can precede an awaited SDK boundary. Keep identity
    // tracking until cleanup settles so a late consumption wins recovery.
    for (const [id, queuedReceipt] of stoppedReceipts) {
      if (host.queuedInputReceipts.get(id) === queuedReceipt) host.queuedInputReceipts.delete(id);
    }
    if (!host.isAlive()) return;
    host.stopping = false;
    host.capabilities.flushPendingProjectCapabilitySettings();
    host.emit({ type: "session_idle", sessionId: host.sessionId });
    notifyRunningChange();
  });
  await host.stoppedInputRecovery;
  return receipt();
}

export function handleAbortCompactionCommand(host: RpcCommandHost): null {
  host.stopping = true;
  notifyRunningChange();
  try {
    host.inner.abortCompaction();
  } finally {
    host.stopping = false;
    notifyRunningChange();
  }
  return null;
}

export function handleAbortBashCommand(host: RpcCommandHost): null {
  host.stopping = true;
  notifyRunningChange();
  try {
    host.inner.abortBash();
  } finally {
    host.stopping = false;
    notifyRunningChange();
  }
  return null;
}
