export const MODEL_IMAGE_UNSUPPORTED = "MODEL_IMAGE_UNSUPPORTED" as const;

export interface ModelImageUnsupportedDetails {
  provider: string;
  modelId: string;
  modelName: string;
  imageCount: number;
}

export interface ModelSettingsFocusTarget {
  provider: string;
  modelId: string;
  focus?: "imageInput";
}

export class ModelImageUnsupportedError extends Error {
  readonly code = MODEL_IMAGE_UNSUPPORTED;
  readonly details: ModelImageUnsupportedDetails;

  constructor(details: ModelImageUnsupportedDetails) {
    const label = details.provider && details.modelId
      ? `${details.provider}/${details.modelId}`
      : details.modelName || details.modelId || "current model";
    super(`The selected model (${label}) does not support image input. Choose an image-capable model.`);
    this.name = "ModelImageUnsupportedError";
    this.details = details;
  }
}

export function isModelImageUnsupportedError(error: unknown): error is ModelImageUnsupportedError {
  if (error instanceof ModelImageUnsupportedError) return true;
  return Boolean(
    error
    && typeof error === "object"
    && (error as { code?: unknown }).code === MODEL_IMAGE_UNSUPPORTED,
  );
}

export function parseModelImageUnsupportedDetails(value: unknown): ModelImageUnsupportedDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  const modelName = typeof record.modelName === "string" && record.modelName.trim()
    ? record.modelName.trim()
    : modelId;
  const imageCount = typeof record.imageCount === "number" && Number.isFinite(record.imageCount) && record.imageCount > 0
    ? Math.floor(record.imageCount)
    : 1;
  if (!provider && !modelId) return null;
  return { provider, modelId, modelName, imageCount };
}

export function extractErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { details?: unknown; errorDetails?: unknown }).details
    ?? (error as { errorDetails?: unknown }).errorDetails;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return undefined;
}
