// Old note conversations keep their tool and resource restrictions.
export function isLegacyNotesSession(entries: readonly unknown[]): boolean {
  let notes = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: string; customType?: string; data?: { policy?: unknown } };
    if (record.type !== "custom" || record.customType !== "piora-remote-policy") continue;
    if (record.data?.policy === "notes") notes = true;
    else if (record.data?.policy !== "agent") throw new Error("Invalid persisted notes session policy");
  }
  return notes;
}
const NOTES_COMMANDS = new Set([
  "prompt", "steer", "follow_up", "abort", "get_state", "get_messages",
  "get_session_stats", "get_tools", "get_commands", "get_available_models",
  "set_model", "set_thinking_level", "set_session_name", "compact",
]);

export function assertNotesSessionCommand(notesOnly: boolean, command: Record<string, unknown>): void {
  if (!notesOnly) return;
  const type = String(command.type);
  if (!NOTES_COMMANDS.has(type)) throw new Error("Command is disabled for notes-only sessions");
  if (["prompt", "steer", "follow_up"].includes(type)
    && (String(command.message ?? "").trimStart().startsWith("/") || command.teamExecution || command.materials)) {
    throw new Error("Notes-only sessions accept plain messages, not commands or runtime materials");
  }
}

export function notesSessionResourceOptions() {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [] as string[],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [] as string[],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  };
}
