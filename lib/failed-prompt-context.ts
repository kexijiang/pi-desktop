import type { SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Called only when admitting a NEW idle prompt, never during retry/fallback.
 * Raw entries remain available to the UI. SDK context edits also cover reload,
 * model routing and compaction, unlike filtering only the outgoing HTTP body.
 */
export function omitFailedPromptHistory(manager: Pick<SessionManager, "getBranch" | "appendContextEdit">): number {
  const branch = manager.getBranch();
  const edits = new Map(branch.filter(entry => entry.type === "context_edit").map(entry => [entry.targetId, entry.replacement]));
  let turn: SessionEntry[] = [];
  let lastAssistant: { stopReason: string } | undefined;
  const omit: string[] = [];
  const finish = () => {
    if (lastAssistant?.stopReason === "error") {
      for (const entry of turn) {
        if (entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role) && edits.get(entry.id) !== null) omit.push(entry.id);
      }
    }
    turn = []; lastAssistant = undefined;
  };
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      // Consecutive inputs can belong to the same queued turn.
      if (lastAssistant) finish();
    }
    if (entry.type === "message" && entry.message.role === "user" || turn.length) {
      turn.push(entry);
      if (entry.type === "message" && entry.message.role === "assistant") lastAssistant = entry.message;
    }
  }
  finish();
  for (const id of omit) manager.appendContextEdit(id, null);
  return omit.length;
}

/**
 * Surgical omission used exclusively when resuming an interrupted multi-step
 * run: removes only trailing failed/aborted assistant entries so the user
 * prompt and all completed toolCall/toolResult pairs remain in SDK context.
 */
export function omitTrailingAssistantErrorOnly(
  manager: Pick<SessionManager, "getBranch" | "appendContextEdit">,
): number {
  const branch = manager.getBranch();
  const edits = new Map(branch.filter(entry => entry.type === "context_edit").map(entry => [entry.targetId, entry.replacement]));
  const omit: string[] = [];
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    if (edits.get(entry.id) === null) continue;
    if (entry.message.role === "assistant" && (entry.message.stopReason === "error" || entry.message.stopReason === "aborted")) {
      omit.push(entry.id);
      continue;
    }
    break;
  }
  for (const id of omit) manager.appendContextEdit(id, null);
  return omit.length;
}
