export interface WorkflowLoadFailure {
  message: string;
  code?: string;
  status?: number;
  retryable: boolean;
  rawMessage?: string;
}

export class WorkflowLoadError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly rawMessage?: string;

  constructor(failure: WorkflowLoadFailure) {
    super(failure.message);
    this.name = "WorkflowLoadError";
    this.code = failure.code;
    this.status = failure.status;
    this.retryable = failure.retryable;
    this.rawMessage = failure.rawMessage;
  }
}

const NON_RETRYABLE_CODES = new Set([
  "WORKFLOW_STATE_CORRUPT",
  "SESSION_NOT_FOUND",
  "INVALID_WORKFLOW_INPUT",
  "INVALID_WORKFLOW",
  "SESSION_PROFILE_MISMATCH",
  "SESSION_PROFILE_MISSING",
  "INVALID_PROFILE_STORE",
]);

type Translate = (key: string, params?: Record<string, string | number>) => string;

function formatDetail(base: string, detail: string, t: Translate): string {
  const compact = detail.replace(/\s+/g, " ").trim().slice(0, 180);
  if (!compact) return base;
  return t("workflow.loadErrorDetail", { base, detail: compact });
}

export async function parseWorkflowLoadResponseError(response: Response, t: Translate): Promise<WorkflowLoadError> {
  const base = t("workflow.loadError");
  let serverError: string | undefined;
  let code: string | undefined;
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) serverError = body.error.trim();
    if (typeof body?.code === "string" && body.code.trim()) code = body.code.trim();
  } catch {
    // Non-JSON proxy or framework error response.
  }

  const isCorrupt = code === "WORKFLOW_STATE_CORRUPT"
    || (response.status >= 500 && Boolean(serverError && /Invalid workflow state/i.test(serverError)));
  const normalizedCode = isCorrupt ? "WORKFLOW_STATE_CORRUPT" : code;
  const retryable = normalizedCode
    ? !NON_RETRYABLE_CODES.has(normalizedCode) && (response.status === 408 || response.status === 429 || response.status >= 500)
    : response.status === 408 || response.status === 429 || response.status >= 500;

  let message: string;
  if (isCorrupt) {
    message = formatDetail(base, t("workflow.loadErrorCorrupt"), t);
  } else {
    const suffix = serverError
      ? `${response.status}: ${serverError}`
      : `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    message = formatDetail(base, suffix, t);
  }

  return new WorkflowLoadError({
    message,
    code: normalizedCode,
    status: response.status,
    retryable,
    rawMessage: serverError,
  });
}

export function classifyWorkflowLoadException(cause: unknown, t: Translate): WorkflowLoadFailure {
  if (cause instanceof WorkflowLoadError) {
    return {
      message: cause.message,
      code: cause.code,
      status: cause.status,
      retryable: cause.retryable,
      rawMessage: cause.rawMessage,
    };
  }
  const base = t("workflow.loadError");
  const name = cause instanceof Error ? cause.name : "";
  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  if (name === "TimeoutError" || /timed?\s*out/i.test(rawMessage)) {
    return {
      message: formatDetail(base, t("workflow.loadErrorTimeout"), t),
      code: "TIMEOUT",
      retryable: true,
      rawMessage,
    };
  }
  if (cause instanceof TypeError || /failed to fetch|networkerror|load failed|fetch failed/i.test(rawMessage)) {
    return {
      message: formatDetail(base, t("workflow.loadErrorNetwork"), t),
      code: "NETWORK_ERROR",
      retryable: true,
      rawMessage,
    };
  }
  return {
    message: rawMessage && rawMessage !== base ? formatDetail(base, rawMessage, t) : base,
    retryable: true,
    rawMessage,
  };
}
