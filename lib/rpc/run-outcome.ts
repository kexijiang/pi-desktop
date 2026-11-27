/**
 * Shared run-outcome classifier for normal Agent mode (and reusable by workflows).
 *
 * Distinguishes intentional user stops and clean completions from unexpected
 * interruptions: non-user aborts (e.g., automatic tool review denial or runtime
 * teardown), output-length truncation, terminated tool batches, empty replies,
 * and provider/transport errors.
 */
import {
  redactTelemetryText,
  type RunInterruptionInfo,
  type RunInterruptionKind,
  type RunTerminationReason,
} from "./run-telemetry";

interface MessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
}

function isAssistantMessage(message: unknown): message is MessageLike {
  return Boolean(message && typeof message === "object" && (message as MessageLike).role === "assistant");
}

function isToolResultMessage(message: unknown): message is MessageLike {
  return Boolean(message && typeof message === "object" && (message as MessageLike).role === "toolResult");
}

function assistantHasVisibleContent(message: MessageLike): boolean {
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const item = block as { type?: string; text?: unknown };
    if (item.type === "text") return typeof item.text === "string" && item.text.trim().length > 0;
    return item.type === "image" || item.type === "toolCall";
  });
}

function assistantHasToolCall(message: MessageLike): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (block) => Boolean(block && typeof block === "object" && (block as { type?: string }).type === "toolCall"),
  );
}

export function extractRunMetrics(
  messages: readonly unknown[],
  startMessageIndex: number,
): { turn: number; lastTool?: string; hasToolProgress: boolean } {
  const slice = startMessageIndex > 0 && startMessageIndex <= messages.length
    ? messages.slice(startMessageIndex)
    : messages;
  let turn = 0;
  let lastTool: string | undefined;
  let hasToolProgress = false;
  for (const raw of slice) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as MessageLike;
    if (msg.role === "assistant") {
      turn += 1;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") {
            const name = (block as { name?: unknown; toolName?: unknown }).name
              ?? (block as { toolName?: unknown }).toolName;
            if (typeof name === "string" && name) lastTool = name;
          }
        }
      }
    } else if (msg.role === "toolResult") {
      hasToolProgress = true;
      if (typeof msg.toolName === "string" && msg.toolName) lastTool = msg.toolName;
    }
  }
  return { turn, lastTool, hasToolProgress };
}

export function classifyErrorKind(errorMessage: string | undefined): {
  kind: RunInterruptionKind;
  reason: RunTerminationReason;
} {
  const text = errorMessage ?? "";
  if (/timed?\s*out/i.test(text)) {
    return { kind: "timeout", reason: /no response data within/i.test(text) ? "model_first_event_timeout" : "model_idle_timeout" };
  }
  if (/stream was interrupted|closed the stream before finishing/i.test(text)) {
    return { kind: "stream_interrupted", reason: "model_stream_interrupted" };
  }
  return { kind: "provider_error", reason: "model_error" };
}

function normalizeAbortReason(raw: string | undefined): RunTerminationReason {
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
      return "wrapper_destroyed";
  }
}

export function classifyRunOutcome(options: {
  sessionMessages: readonly unknown[];
  startMessageIndex: number;
  lastAssistant?: unknown;
  priorAssistant?: unknown;
  aborted?: boolean;
  abortReason?: string;
  abortDetail?: string;
  runId?: string;
  commandId?: string;
  now?: number;
}): RunInterruptionInfo | null {
  const now = options.now ?? Date.now();
  const { hasToolProgress } = extractRunMetrics(options.sessionMessages, options.startMessageIndex);
  const runMessages = options.startMessageIndex >= 0 && options.startMessageIndex <= options.sessionMessages.length
    ? options.sessionMessages.slice(options.startMessageIndex)
    : [];

  if (options.aborted) {
    const reason = normalizeAbortReason(options.abortReason ?? "user_abort");
    if (reason === "user_abort") return null;
    if (reason === "tool_review_denied") {
      return {
        runId: options.runId,
        commandId: options.commandId,
        kind: "tool_review_denied",
        reason: "tool_review_denied",
        detail: redactTelemetryText(options.abortDetail),
        timestamp: now,
        hasToolProgress,
        resumable: hasToolProgress,
      };
    }
    return {
      runId: options.runId,
      commandId: options.commandId,
      kind: "runtime_interrupted",
      reason,
      detail: redactTelemetryText(options.abortDetail),
      timestamp: now,
      hasToolProgress,
      resumable: true,
    };
  }

  let latestAssistant: MessageLike | undefined;
  for (let i = runMessages.length - 1; i >= 0; i -= 1) {
    const candidate = runMessages[i];
    if (isAssistantMessage(candidate)) {
      latestAssistant = candidate;
      break;
    }
  }
  if (!latestAssistant && options.lastAssistant && options.lastAssistant !== options.priorAssistant && isAssistantMessage(options.lastAssistant)) {
    latestAssistant = options.lastAssistant;
  }
  if (!latestAssistant) return null;

  const stopReason = latestAssistant.stopReason;
  if (stopReason === "error") {
    const detail = redactTelemetryText(latestAssistant.errorMessage);
    const { kind, reason } = classifyErrorKind(detail);
    return {
      runId: options.runId,
      commandId: options.commandId,
      kind,
      reason,
      detail,
      timestamp: now,
      hasToolProgress,
      resumable: true,
    };
  }

  if (stopReason === "aborted") {
    return {
      runId: options.runId,
      commandId: options.commandId,
      kind: "upstream_abort",
      reason: "model_upstream_abort",
      detail: redactTelemetryText(latestAssistant.errorMessage),
      timestamp: now,
      hasToolProgress,
      resumable: true,
    };
  }

  if (stopReason === "length") {
    return {
      runId: options.runId,
      commandId: options.commandId,
      kind: "output_truncated",
      reason: "model_output_truncated",
      timestamp: now,
      hasToolProgress,
      resumable: true,
    };
  }

  const tailMessage = runMessages.at(-1);
  if (stopReason === "toolUse" || (isToolResultMessage(tailMessage) && assistantHasToolCall(latestAssistant))) {
    return {
      runId: options.runId,
      commandId: options.commandId,
      kind: "tool_batch_terminated",
      reason: "tool_batch_terminated",
      timestamp: now,
      hasToolProgress: true,
      resumable: true,
    };
  }

  if (!assistantHasVisibleContent(latestAssistant)) {
    return {
      runId: options.runId,
      commandId: options.commandId,
      kind: "empty_response",
      reason: "model_empty_response",
      timestamp: now,
      hasToolProgress,
      resumable: true,
    };
  }

  return null;
}

export function buildInterruptionResumePrompt(interruption?: Partial<RunInterruptionInfo> | null): string {
  const reasonNote = interruption?.kind === "output_truncated"
    ? "The previous response reached the output length limit before finishing."
    : interruption?.detail
      ? `The previous run was interrupted before finishing (${redactTelemetryText(interruption.detail, 140)}).`
      : "The previous run was interrupted before finishing.";
  return `${reasonNote} Continue the current task using the existing conversation and completed tool results. Check completed actions and current workspace state before taking further action; do not restart the task or repeat completed operations.`;
}
