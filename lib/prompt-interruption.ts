/**
 * Frontend run-interruption derivation and reconciliation helpers.
 *
 * Keeps `hooks/useAgentSession.ts` and `components/MessageView.tsx` thin by
 * centralizing how persisted assistant messages, SSE events, and polled server
 * state map into persistent interruption cards and resume actions.
 */
import { getAssistantErrorMessage, getDisplayableAssistantBlocks, isAssistantAborted } from "./message-display";
import { buildInterruptionResumePrompt } from "./rpc/run-outcome";
import type { RunInterruptionInfo, RunInterruptionKind } from "./rpc/run-telemetry";
import type { AgentMessage, AssistantMessage } from "./types";

export { buildInterruptionResumePrompt };
export type { RunInterruptionInfo, RunInterruptionKind };

export interface AssistantInterruptionView {
  interruption: RunInterruptionInfo;
  /** Suppresses the gray neutral "Generation stopped" pill when a concrete non-user cause is known. */
  overridesAbortedNotice: boolean;
}

/**
 * Inspect whether the turn containing `messageIndex` has completed tool calls
 * or tool results (making in-place continuation valuable vs. retrying from scratch).
 */
export function hasTurnToolProgress(messages: ArrayLike<AgentMessage | undefined>, messageIndex: number): boolean {
  for (let i = Math.min(messageIndex, messages.length - 1); i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry) continue;
    if (entry.role === "user") break;
    if (entry.role === "toolResult") return true;
    if (entry.role === "assistant" && Array.isArray(entry.content)
      && entry.content.some((block) => block.type === "toolCall")) {
      return true;
    }
  }
  return false;
}

/**
 * Derive an actionable interruption view for an assistant message.
 * Preserves existing `stopReason === "error"` provider-error rendering and
 * intentional user stops (`stopReason === "aborted"` with no server interruption).
 */
export function deriveAssistantInterruption(
  message: AssistantMessage,
  options: {
    isStreaming?: boolean;
    isLastMessage?: boolean;
    hasToolProgress?: boolean;
    serverInterruption?: RunInterruptionInfo | null;
  } = {},
): AssistantInterruptionView | null {
  if (options.isStreaming) return null;
  const hasToolProgress = Boolean(options.hasToolProgress || options.serverInterruption?.hasToolProgress);
  const blocks = getDisplayableAssistantBlocks(message, { isStreaming: false });
  const providerError = getAssistantErrorMessage(message, { isStreaming: false });
  const aborted = isAssistantAborted(message, { isStreaming: false });

  if (message.stopReason === "length") {
    return {
      interruption: {
        kind: "output_truncated",
        reason: "model_output_truncated",
        timestamp: message.timestamp ?? Date.now(),
        hasToolProgress,
        resumable: true,
      },
      overridesAbortedNotice: false,
    };
  }

  // Non-user aborts (e.g. automatic tool review denial or server teardown)
  // replace the ambiguous neutral "Generation stopped" indicator.
  if (aborted && options.isLastMessage && options.serverInterruption && options.serverInterruption.reason !== "user_abort") {
    return {
      interruption: {
        ...options.serverInterruption,
        hasToolProgress,
      },
      overridesAbortedNotice: true,
    };
  }

  if (providerError || aborted) return null;

  if (options.isLastMessage && message.stopReason === "toolUse") {
    return {
      interruption: {
        kind: "tool_batch_terminated",
        reason: "tool_batch_terminated",
        timestamp: message.timestamp ?? Date.now(),
        hasToolProgress: true,
        resumable: true,
      },
      overridesAbortedNotice: false,
    };
  }

  if (options.isLastMessage && blocks.length === 0) {
    return {
      interruption: {
        kind: "empty_response",
        reason: "model_empty_response",
        timestamp: message.timestamp ?? Date.now(),
        hasToolProgress,
        resumable: true,
      },
      overridesAbortedNotice: false,
    };
  }

  return null;
}

/**
 * Extract durable interruption state from a polled `/api/agent/[id]` response
 * when SSE events were dropped or the server restarted mid-run.
 */
export function interruptionFromCommandState(
  promptCommand?: { commandId?: string; status?: string } | null,
  state?: {
    lastRunInterruption?: RunInterruptionInfo | null;
    lastPromptFailed?: boolean;
    lastPromptErrorSummary?: string;
  } | null,
): RunInterruptionInfo | null {
  if (state?.lastRunInterruption) return state.lastRunInterruption;
  if (promptCommand?.status === "interrupted") {
    return {
      commandId: promptCommand.commandId,
      kind: "runtime_interrupted",
      reason: "process_interrupted",
      detail: state?.lastPromptErrorSummary,
      timestamp: Date.now(),
      hasToolProgress: false,
      resumable: true,
    };
  }
  if (promptCommand?.status === "failed" || promptCommand?.status === "expired") {
    return {
      commandId: promptCommand.commandId,
      kind: "command_failed",
      reason: promptCommand.status === "expired" ? "command_expired" : "command_failed",
      detail: state?.lastPromptErrorSummary,
      timestamp: Date.now(),
      hasToolProgress: false,
      resumable: true,
    };
  }
  if (state?.lastPromptFailed && state.lastPromptErrorSummary) {
    return {
      kind: "provider_error",
      reason: "model_error",
      detail: state.lastPromptErrorSummary,
      timestamp: Date.now(),
      hasToolProgress: false,
      resumable: true,
    };
  }
  return null;
}

/** Whether a standalone tail banner should be rendered below ChatHistory. */
export function shouldShowTailInterruptionBanner(
  messages: readonly AgentMessage[],
  interruption: RunInterruptionInfo | null,
): boolean {
  if (!interruption) return false;
  const last = messages.at(-1);
  if (!last) return true;
  if (last.role !== "assistant") return true;
  // If the last assistant message already shows an error or derived interruption
  // notice inline, avoid rendering a duplicate banner below the list.
  if (getAssistantErrorMessage(last, { isStreaming: false })) return false;
  if (deriveAssistantInterruption(last, { isLastMessage: true, serverInterruption: interruption })) return false;
  return true;
}
