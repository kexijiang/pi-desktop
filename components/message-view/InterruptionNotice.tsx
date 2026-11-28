"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { RunInterruptionInfo } from "@/lib/prompt-interruption";
import { AliIcon } from "../AliIcon";

interface Props {
  interruption: RunInterruptionInfo;
  hasToolProgress?: boolean;
  disabled?: boolean;
  marginTop?: number;
  onContinue?: (interruption: RunInterruptionInfo) => Promise<void>;
  onRetry?: () => Promise<void>;
  onDismiss?: () => void;
}

function resolveInterruptionReason(
  interruption: RunInterruptionInfo,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (interruption.kind) {
    case "output_truncated":
      return t("chat.interrupted.reason.output_truncated");
    case "empty_response":
      return t("chat.interrupted.reason.empty_response");
    case "tool_batch_terminated":
      return t("chat.interrupted.reason.tool_batch_terminated");
    case "tool_review_denied":
      return interruption.detail
        ? t("chat.interrupted.reason.tool_review_denied_detail", { detail: interruption.detail })
        : t("chat.interrupted.reason.tool_review_denied");
    case "timeout":
      return interruption.detail || t("chat.interrupted.reason.timeout");
    case "stream_interrupted":
    case "upstream_abort":
      return interruption.detail || t("chat.interrupted.reason.stream_interrupted");
    case "runtime_interrupted":
      return interruption.detail || t("chat.interrupted.reason.runtime_interrupted");
    case "extension_error":
    case "command_failed":
    case "provider_error":
    default:
      return interruption.detail || t("chat.interrupted.reason.unknown");
  }
}

export function InterruptionNotice({
  interruption,
  hasToolProgress,
  disabled,
  marginTop = 8,
  onContinue,
  onRetry,
  onDismiss,
}: Props) {
  const { t } = useI18n();
  const inFlightRef = useRef(false);
  const [busyAction, setBusyAction] = useState<"continue" | "retry" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canContinue = Boolean(
    onContinue
    && interruption.resumable
    && (hasToolProgress || interruption.hasToolProgress || interruption.kind === "output_truncated"),
  );
  const reasonText = resolveInterruptionReason(interruption, t);

  const runAction = (kind: "continue" | "retry", fn: () => Promise<void>) => {
    if (disabled || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusyAction(kind);
    setActionError(null);
    void fn()
      .catch((error) => setActionError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        inFlightRef.current = false;
        setBusyAction(null);
      });
  };

  return (
    <div
      role="alert"
      data-interruption-kind={interruption.kind}
      style={{
        marginTop,
        padding: "8px 10px",
        border: "1px solid rgba(245, 158, 11, 0.38)",
        borderRadius: "var(--radius-control)",
        background: "rgba(245, 158, 11, 0.08)",
        color: "var(--text-primary)",
        fontSize: "var(--text-sm)",
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <strong style={{ fontWeight: 600 }}>{t("chat.interrupted.title")}</strong>
          <span>{reasonText}</span>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="message-delete-button"
            onClick={onDismiss}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <AliIcon name="close" size={11} />
          </button>
        )}
      </div>
      {(canContinue || onRetry) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
          {canContinue && onContinue && (
            <button
              type="button"
              className="message-delete-button"
              data-interruption-action="continue"
              disabled={disabled || busyAction !== null}
              onClick={() => runAction("continue", () => onContinue(interruption))}
            >
              <AliIcon name="play" size={11} />
              {t("chat.interrupted.continue")}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              className="message-delete-button"
              data-interruption-action="retry"
              disabled={disabled || busyAction !== null}
              onClick={() => runAction("retry", onRetry)}
            >
              <AliIcon name="reload" size={11} />
              {canContinue ? t("chat.interrupted.retryFromScratch") : t("chat.retryMessage")}
            </button>
          )}
          {actionError && <span role="alert" style={{ color: "#ef4444", fontSize: "var(--text-xs)" }}>{actionError}</span>}
        </div>
      )}
    </div>
  );
}
