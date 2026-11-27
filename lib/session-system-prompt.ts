import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  readSystemPromptConfig,
  resolveSystemPromptSelection,
  type SystemPromptConfig,
} from "./system-prompt-config";
import type {
  SessionSystemPromptBinding,
  SystemPromptApplyMode,
  SystemPromptSelection,
} from "./system-prompt-types";

export const SESSION_SYSTEM_PROMPT_ENTRY_TYPE = "piora-system-prompt-binding";

type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

function copy(binding: SessionSystemPromptBinding): SessionSystemPromptBinding {
  return { ...binding };
}

function normalizeApplyMode(mode: unknown): SystemPromptApplyMode {
  return mode === "append" ? "append" : "replace";
}

export function isSessionSystemPromptBinding(value: unknown): value is SessionSystemPromptBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<SessionSystemPromptBinding>;
  return binding.version === 1
    && Number.isInteger(binding.revision)
    && (binding.revision ?? 0) > 0
    && (binding.source === "default" || binding.source === "template")
    && (binding.templateId === null || typeof binding.templateId === "string")
    && (binding.templateName === null || typeof binding.templateName === "string")
    && (binding.prompt === null || typeof binding.prompt === "string")
    && (binding.applyMode === undefined || binding.applyMode === "append" || binding.applyMode === "replace")
    && typeof binding.appliedAt === "string";
}

export function readLatestSessionSystemPromptBinding(
  entries: readonly SessionEntryLike[],
): SessionSystemPromptBinding | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SESSION_SYSTEM_PROMPT_ENTRY_TYPE) continue;
    if (isSessionSystemPromptBinding(entry.data)) return copy(entry.data);
  }
  return null;
}

export function summarizeSessionSystemPromptBinding(binding: SessionSystemPromptBinding | null): SessionSystemPromptBinding | null {
  if (!binding?.prompt || Buffer.byteLength(JSON.stringify(binding.prompt)) <= 4096) return binding;
  return { ...binding, prompt: null, promptDeferred: true };
}

export function createSessionSystemPromptBinding(
  selection: SystemPromptSelection,
  config: SystemPromptConfig = readSystemPromptConfig(),
  previous: SessionSystemPromptBinding | null = null,
): SessionSystemPromptBinding {
  const resolved = resolveSystemPromptSelection(config, selection);
  return {
    version: 1,
    revision: (previous?.revision ?? 0) + 1,
    source: resolved.source,
    templateId: resolved.templateId,
    templateName: resolved.templateName,
    prompt: resolved.prompt,
    ...(resolved.prompt !== null ? { applyMode: resolved.applyMode } : {}),
    appliedAt: new Date().toISOString(),
  };
}

export function appendSessionSystemPromptBinding(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  binding: SessionSystemPromptBinding,
): string {
  return sessionManager.appendCustomEntry(SESSION_SYSTEM_PROMPT_ENTRY_TYPE, binding);
}

export function copySessionSystemPromptBinding(binding: SessionSystemPromptBinding): SessionSystemPromptBinding {
  return { ...binding, revision: 1, appliedAt: new Date().toISOString() };
}

export function resolveEffectiveSessionSystemPrompt(
  entries: readonly SessionEntryLike[],
  config: SystemPromptConfig = readSystemPromptConfig(),
): { prompt: string | null; applyMode: SystemPromptApplyMode } {
  const binding = readLatestSessionSystemPromptBinding(entries);
  if (binding) {
    return {
      prompt: binding.prompt,
      applyMode: normalizeApplyMode(binding.applyMode),
    };
  }
  const resolvedDefault = resolveSystemPromptSelection(config, { mode: "default" });
  return {
    prompt: resolvedDefault.prompt,
    applyMode: resolvedDefault.applyMode,
  };
}

export function resolveSessionSystemPrompt(
  entries: readonly SessionEntryLike[],
  basePrompt: string | undefined,
  config: SystemPromptConfig = readSystemPromptConfig(),
): string | undefined {
  const effective = resolveEffectiveSessionSystemPrompt(entries, config);
  if (effective.prompt === null || effective.applyMode === "append") return basePrompt;
  return effective.prompt;
}

export function resolveSessionAppendTemplatePrompt(
  entries: readonly SessionEntryLike[],
  config: SystemPromptConfig = readSystemPromptConfig(),
): string | undefined {
  const effective = resolveEffectiveSessionSystemPrompt(entries, config);
  if (effective.applyMode !== "append" || effective.prompt === null) return undefined;
  return effective.prompt.trim() ? effective.prompt : undefined;
}

export function selectionForSessionSystemPromptBinding(
  binding: SessionSystemPromptBinding | null,
): SystemPromptSelection {
  if (!binding || binding.source === "default" || !binding.templateId) return { mode: "default" };
  return { mode: "template", templateId: binding.templateId };
}

export interface SessionAppendSystemPromptOptions {
  customInstructions?: string;
  fileReferenceInstructions?: string;
  subagentSystemPrompt?: string;
  sideChatInstructions?: string;
}

export function buildSessionAppendSystemPrompt(
  baseAppend: readonly string[],
  options: SessionAppendSystemPromptOptions = {},
): string[] {
  const appended: string[] = [];
  if (options.customInstructions?.trim()) {
    appended.push(`<custom_instructions>\n${options.customInstructions}\n</custom_instructions>`);
  }
  appended.push(...baseAppend);
  if (options.fileReferenceInstructions) {
    appended.push(`<file_references>\n${options.fileReferenceInstructions}\n</file_references>`);
  }
  if (options.subagentSystemPrompt) {
    appended.push(`<subagent_role>\n${options.subagentSystemPrompt}\n</subagent_role>`);
  }
  if (options.sideChatInstructions) {
    appended.push(options.sideChatInstructions);
  }
  return appended;
}
