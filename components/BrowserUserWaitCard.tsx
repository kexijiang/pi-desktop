"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ToolResultMessage } from "@/lib/types";
import { browserWaitPurpose, type BrowserWaitPurpose } from "@/lib/browser-wait-policy";

function resultText(result?: ToolResultMessage): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function resultStatus(result?: ToolResultMessage): string | null {
  const details = result?.details;
  const status = details && typeof details === "object" ? (details as { status?: unknown }).status : undefined;
  return typeof status === "string" ? status : null;
}

function statusKey(result?: ToolResultMessage): string | null {
  const status = resultStatus(result);
  if (status === "continued") return "browser.waitContinued";
  if (status === "cancelled") return "browser.waitCancelled";
  if (status === "timeout") return "browser.waitTimeout";
  if (status === "aborted") return "browser.waitAborted";
  if (status === "unsupported") return "browser.waitUnsupported";
  return null;
}

export function BrowserUserWaitCard({
  sessionId,
  toolCallId,
  reason,
  result,
  historical,
  purpose,
}: {
  sessionId?: string;
  toolCallId?: string;
  reason: string;
  result?: ToolResultMessage;
  historical: boolean;
  purpose?: BrowserWaitPurpose;
}) {
  const { t } = useI18n();
  const unsupported = resultStatus(result) === "unsupported";
  const login = browserWaitPurpose(reason, purpose) === "login";
  const running = !unsupported && !historical && (!result || result.isStreaming === true);
  const [cancelling, setCancelling] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const cancelWait = async () => {
    if (!sessionId || !toolCallId || cancelling) return;
    setCancelling(true);
    setNote(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser-wait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "cancel", toolCallId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        setNote(payload?.error || t("browser.actionFailed"));
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : t("browser.actionFailed"));
    } finally {
      setCancelling(false);
    }
  };

  const finishedKey = statusKey(result);
  if (login) {
    if (running || resultStatus(result) === "continued" || historical) return null;
    return finishedKey ? <p role="status" className="browser-user-wait-status">{t(finishedKey)}</p> : null;
  }
  return <section className="browser-user-wait" aria-live="polite">
    <p className="browser-user-wait-title">{t("browser.waitTitle")}</p>
    {running ? <p className="browser-user-wait-reason">{reason}</p> : <p className="browser-user-wait-status">{finishedKey ? t(finishedKey) : (resultText(result) || reason)}</p>}
    {running && sessionId && toolCallId ? <div className="browser-user-wait-actions">
      <button type="button" disabled={cancelling} onClick={() => void cancelWait()}>{t("browser.waitCancel")}</button>
    </div> : null}
    {note ? <p className="browser-user-wait-status">{note}</p> : null}
  </section>;
}
