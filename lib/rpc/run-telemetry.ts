/**
 * Structured single-line run telemetry for diagnosing prompt interruptions,
 * provider timeouts/disconnects, retries, fallbacks, and runtime aborts.
 *
 * All output goes through `console.log` (info) / `console.warn` (warn) with the
 * `[pi-web:run]` prefix so the Electron server supervisor forwards it directly
 * into `piora.log` without leaking credentials or sensitive headers.
 */

export type RunTerminationReason =
  | "completed"
  | "user_abort"
  | "tool_review_denied"
  | "workflow_abort"
  | "wrapper_destroyed"
  | "idle_timeout"
  | "restart_extensions"
  | "fork"
  | "file_mutation"
  | "process_shutdown"
  | "lru_eviction"
  | "model_first_event_timeout"
  | "model_idle_timeout"
  | "model_stream_interrupted"
  | "model_transport_error"
  | "model_upstream_abort"
  | "model_error"
  | "model_output_truncated"
  | "model_empty_response"
  | "tool_batch_terminated"
  | "auto_retry_start"
  | "auto_retry_end"
  | "auto_compaction_failed"
  | "model_fallback_triggered"
  | "model_fallback_switched"
  | "model_fallback_exhausted"
  | "extension_error"
  | "preflight_error"
  | "process_interrupted"
  | "command_failed"
  | "command_expired"
  | "command_cancelled";

export type RunInterruptionKind =
  | "provider_error"
  | "timeout"
  | "stream_interrupted"
  | "upstream_abort"
  | "tool_review_denied"
  | "output_truncated"
  | "empty_response"
  | "tool_batch_terminated"
  | "runtime_interrupted"
  | "extension_error"
  | "command_failed";

export interface RunInterruptionInfo {
  runId?: string;
  commandId?: string;
  kind: RunInterruptionKind;
  reason: RunTerminationReason;
  detail?: string;
  errorCode?: string;
  timestamp: number;
  hasToolProgress: boolean;
  resumable: boolean;
}

export interface RunTelemetryEvent {
  sessionId?: string;
  runId?: string;
  commandId?: string;
  reason: RunTerminationReason;
  turn?: number;
  lastTool?: string;
  model?: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  elapsedMs?: number;
  extra?: Record<string, string | number | boolean | undefined>;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(sk|pk|rk|ak|pat|ghp|gho|ghu|ghs|glpat)-[A-Za-z0-9_-]{12,}/gi, "$1-[REDACTED]"],
  [/([?&](?:api[_-]?key|token|access[_-]?token|secret|key|auth)=)[^&\s"'`]+/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|authorization|x-api-key|secret|token)\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[REDACTED]"],
];

export function redactTelemetryText(raw: unknown, maxLength = 240): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > maxLength) {
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  }
  return text;
}

export function formatTelemetryModel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record = model as { provider?: unknown; id?: unknown; model?: unknown };
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const id = typeof record.id === "string"
    ? record.id.trim()
    : typeof record.model === "string"
      ? record.model.trim()
      : "";
  if (provider && id) return `${provider}/${id}`;
  return id || provider || undefined;
}

function formatField(key: string, value: string | number | boolean | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`;
  const cleaned = value.replace(/[\r\n]+/g, " ").trim();
  if (!cleaned) return null;
  return /\s/.test(cleaned) ? `${key}=${JSON.stringify(cleaned)}` : `${key}=${cleaned}`;
}

export function formatRunTelemetryLine(event: RunTelemetryEvent): string {
  const fields: Array<string | null> = [
    formatField("session", event.sessionId),
    formatField("run", event.runId),
    formatField("cmd", event.commandId),
    formatField("reason", event.reason),
    formatField("turn", event.turn),
    formatField("lastTool", event.lastTool),
    formatField("model", event.model),
    formatField("stopReason", event.stopReason),
    formatField("errorCode", event.errorCode),
    formatField("elapsedMs", event.elapsedMs !== undefined ? Math.max(0, Math.round(event.elapsedMs)) : undefined),
    formatField("error", redactTelemetryText(event.errorMessage)),
  ];
  if (event.extra) {
    for (const [key, value] of Object.entries(event.extra)) {
      fields.push(formatField(key, typeof value === "string" ? redactTelemetryText(value, 120) : value));
    }
  }
  return `[pi-web:run] ${fields.filter(Boolean).join(" ")}`;
}

export function logRunEvent(level: "info" | "warn", event: RunTelemetryEvent): void {
  const line = formatRunTelemetryLine(event);
  if (level === "warn") console.warn(line);
  else console.log(line);
}
