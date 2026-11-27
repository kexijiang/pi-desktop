"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  parseModelImageUnsupportedDetails,
  type ModelSettingsFocusTarget,
} from "@/lib/model-image-error";
import type { UserMessage } from "@/lib/types";
import { AliIcon } from "../AliIcon";
import type { ModelOption } from "./shared";

interface ComposerWarningProps {
  currentModel: ModelOption;
  modelOptions: ModelOption[];
  disabled?: boolean;
  onOpenModels?: (target?: ModelSettingsFocusTarget) => void;
  onSelectModel?: (provider: string, modelId: string) => Promise<boolean> | void;
  onClearImages: () => void;
}

export function ImageUnsupportedComposerWarning({
  currentModel,
  modelOptions,
  disabled,
  onOpenModels,
  onSelectModel,
  onClearImages,
}: ComposerWarningProps) {
  const { t } = useI18n();
  const [switching, setSwitching] = useState(false);
  const visionModels = useMemo(
    () => modelOptions.filter((option) => option.supportsImages === true),
    [modelOptions],
  );
  const modelLabel = currentModel.name || currentModel.modelId;

  return (
    <div
      role="status"
      data-image-unsupported-warning="composer"
      style={{
        marginBottom: 8,
        padding: "8px 10px",
        border: "1px solid rgba(234, 179, 8, 0.38)",
        borderRadius: "var(--radius-control)",
        background: "rgba(234, 179, 8, 0.09)",
        color: "var(--text-primary)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <AliIcon name="warning" size={13} style={{ marginTop: 2, color: "#ca8a04", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflowWrap: "anywhere" }}>
            {t("chat.imageUnsupported.composerWarning", { model: modelLabel })}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
            {onOpenModels && (
              <button
                type="button"
                className="message-delete-button"
                data-image-action="open-models"
                disabled={disabled}
                onClick={() => onOpenModels({
                  provider: currentModel.provider,
                  modelId: currentModel.modelId,
                  focus: "imageInput",
                })}
              >
                {t("chat.imageUnsupported.openSettings")}
              </button>
            )}
            {onSelectModel && visionModels.length > 0 && (
              <select
                aria-label={t("chat.imageUnsupported.switchModel")}
                data-image-action="switch-model"
                disabled={disabled || switching}
                defaultValue=""
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const target = visionModels.find((item) => `${item.provider}:${item.modelId}` === value);
                  if (!target) return;
                  setSwitching(true);
                  void Promise.resolve(onSelectModel(target.provider, target.modelId)).finally(() => setSwitching(false));
                  event.target.value = "";
                }}
                style={{
                  height: 24,
                  padding: "0 6px",
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  fontSize: "var(--text-xs)",
                }}
              >
                <option value="">{t("chat.imageUnsupported.switchModel")}</option>
                {visionModels.map((item) => (
                  <option key={`${item.provider}:${item.modelId}`} value={`${item.provider}:${item.modelId}`}>
                    {item.name} ({item.provider})
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="message-delete-button"
              data-image-action="clear-images"
              disabled={disabled}
              onClick={onClearImages}
            >
              {t("chat.imageUnsupported.removeImages")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FailureCardProps {
  message: UserMessage;
  modelList?: { id: string; name: string; provider: string; supportsImages?: boolean }[];
  disabled?: boolean;
  onOpenModels?: (target?: ModelSettingsFocusTarget) => void;
  onSelectModel?: (provider: string, modelId: string) => Promise<boolean>;
  onRetry?: () => Promise<void>;
  onRetryWithoutImages?: () => Promise<void>;
}

export function ImageUnsupportedFailureCard({
  message,
  modelList,
  disabled,
  onOpenModels,
  onSelectModel,
  onRetry,
  onRetryWithoutImages,
}: FailureCardProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const details = parseModelImageUnsupportedDetails(message.sendErrorDetails);
  const visionModels = useMemo(
    () => (modelList ?? []).filter((item) => item.supportsImages === true),
    [modelList],
  );

  const imageCount = details?.imageCount
    ?? (Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "image").length
      : message.recoveryDraft?.images?.length ?? 1);
  const modelLabel = details
    ? (details.provider && details.modelName && details.modelName !== details.provider
        ? `${details.modelName} (${details.provider})`
        : details.modelName || details.modelId)
    : t("common.models");

  const hasRemainingContent = Boolean(
    message.recoveryDraft
      ? (message.recoveryDraft.value.trim().length > 0 || (message.recoveryDraft.files?.length ?? 0) > 0)
      : (typeof message.content === "string"
          ? message.content.trim().length > 0
          : Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text.trim().length > 0)),
  );

  return (
    <div
      role="alert"
      data-image-unsupported-card="true"
      style={{
        marginTop: -6,
        marginBottom: 10,
        padding: "8px 10px",
        maxWidth: "85%",
        border: "1px solid rgba(239, 68, 68, 0.32)",
        borderRadius: "var(--radius-control)",
        background: "rgba(239, 68, 68, 0.06)",
        color: "var(--text)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600, color: "var(--status-failed, #dc2626)", marginBottom: 4 }}>
        {t("chat.imageUnsupported.title")}
      </div>
      <div style={{ overflowWrap: "anywhere", color: "var(--text-muted)" }}>
        {t("chat.imageUnsupported.body", { model: modelLabel, count: imageCount })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
        {onOpenModels && (
          <button
            type="button"
            className="message-delete-button"
            data-image-action="open-models"
            disabled={disabled || busy}
            onClick={() => onOpenModels(details?.provider && details?.modelId
              ? { provider: details.provider, modelId: details.modelId, focus: "imageInput" }
              : undefined)}
          >
            {t("chat.imageUnsupported.openSettings")}
          </button>
        )}
        {onSelectModel && (
          visionModels.length > 0 ? (
            <select
              aria-label={t("chat.imageUnsupported.switchModel")}
              data-image-action="switch-model"
              disabled={disabled || busy}
              defaultValue=""
              onChange={(event) => {
                const selected = event.target.value;
                if (!selected) return;
                const target = visionModels.find((item) => `${item.provider}:${item.id}` === selected);
                if (!target) return;
                setBusy(true);
                setActionError(null);
                void onSelectModel(target.provider, target.id)
                  .then(async (ok) => {
                    if (ok && onRetry) await onRetry();
                  })
                  .catch((error) => setActionError(error instanceof Error ? error.message : String(error)))
                  .finally(() => setBusy(false));
                event.target.value = "";
              }}
              style={{
                height: 24,
                padding: "0 6px",
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: "var(--text-xs)",
              }}
            >
              <option value="">{t("chat.imageUnsupported.switchModel")}</option>
              {visionModels.map((item) => (
                <option key={`${item.provider}:${item.id}`} value={`${item.provider}:${item.id}`}>
                  {item.name} ({item.provider})
                </option>
              ))}
            </select>
          ) : (
            <span style={{ color: "var(--text-dim)" }}>{t("chat.imageUnsupported.noVisionModels")}</span>
          )
        )}
        {hasRemainingContent && onRetryWithoutImages && (
          <button
            type="button"
            className="message-delete-button"
            data-image-action="remove-and-send"
            disabled={disabled || busy}
            onClick={() => {
              if (disabled || busy) return;
              setBusy(true);
              setActionError(null);
              void onRetryWithoutImages()
                .catch((error) => setActionError(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
          >
            {t("chat.imageUnsupported.removeAndSend")}
          </button>
        )}
      </div>
      {actionError && (
        <div role="alert" style={{ marginTop: 6, color: "var(--status-failed, #dc2626)" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}
