"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DownloadLink, getFileApiUrl, type FileViewerProps } from "./shared";

/** Locate unsupported files; never execute them or bypass the file allow-list. */
export function UnsupportedFileViewer({ filePath, sourceSessionId, active = true }: FileViewerProps) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const reveal = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    setError(null);
    try {
      // Metadata uses the same real-path/allowed-root checks as file preview.
      const response = await fetch(getFileApiUrl(filePath, "meta", sourceSessionId), { signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      if (signal?.aborted) return;
      if (!window.piDesktop?.revealPath) throw new Error(t("chatContext.desktopOnly"));
      if (!await window.piDesktop.revealPath(filePath)) throw new Error(t("chatContext.revealFailed"));
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (signal?.aborted) attempted.current = false;
      setBusy(false);
    }
  }, [filePath, sourceSessionId, t]);

  useEffect(() => {
    if (!active || attempted.current) return;
    const controller = new AbortController();
    // Schedule after effect replay so Strict Mode cannot suppress the only attempt.
    const timer = setTimeout(() => { attempted.current = true; void reveal(controller.signal); }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, reveal]);

  return <div style={{ padding: 24, display: "grid", gap: 12, alignContent: "start" }}>
    <p>{t("files.unsupportedPreview")}</p>
    <p style={{ overflowWrap: "anywhere", color: "var(--text-muted)" }}>{filePath}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => { void reveal(); }}>{t("chatContext.reveal")}</button>
    <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
  </div>;
}
