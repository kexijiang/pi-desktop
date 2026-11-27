"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BrowserUserWaitSnapshot, BrowserUserWaitStatus } from "@/lib/browser-user-wait";
import { browserWaitPurpose, type BrowserWaitPurpose } from "@/lib/browser-wait-policy";

type Snapshot = { wait: BrowserUserWaitSnapshot | null; outcome?: { toolCallId: string; status: BrowserUserWaitStatus; endedAt: number; purpose?: BrowserWaitPurpose } | null };
export function BrowserHandoffNotice({ sessionId, busy, visible = true, deferInitialFetch = false, onWaitingChange }: { sessionId?: string; busy: boolean; visible?: boolean; deferInitialFetch?: boolean; onWaitingChange?: (waiting: boolean) => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<{ id: string; data: Snapshot; receivedAt: number } | null>(null);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || deferInitialFetch) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingVisibility = false;
    const schedule = (delayMs: number) => {
      if (!busy || controller.signal.aborted) return;
      if (document.visibilityState === "hidden") {
        waitingVisibility = true;
        return;
      }
      waitingVisibility = false;
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, delayMs);
    };
    const refresh = async () => {
      let loginWaiting = false;
      let hasActiveWait = false;
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser-wait`, { signal: controller.signal, cache: "no-store" });
        if (response.ok) {
          const data: Snapshot = await response.json();
          hasActiveWait = Boolean(data.wait);
          loginWaiting = Boolean(data.wait && browserWaitPurpose(data.wait.reason, data.wait.purpose) === "login");
          if (!controller.signal.aborted) setSnapshot({ id: sessionId, data, receivedAt: Date.now() });
        }
      } catch { /* Reconcile again without turning a network interruption into a resumed notice. */ }
      schedule(loginWaiting ? 250 : hasActiveWait ? 1_500 : 4_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden" && waitingVisibility && busy && !controller.signal.aborted) {
        waitingVisibility = false;
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionId, busy, deferInitialFetch]);
  const isWaiting = snapshot?.id === sessionId && snapshot?.data.wait?.backend === "desktop";
  const wait = snapshot && snapshot.id === sessionId ? snapshot.data.wait : null;
  const login = Boolean(wait && browserWaitPurpose(wait.reason, wait.purpose) === "login");
  useEffect(() => {
    if (!visible) { opened.current = null; return; }
    if (!isWaiting || !sessionId || !wait) return;
    const key = `${sessionId}:${wait.toolCallId}`;
    if (opened.current === key) return;
    opened.current = key;
    window.dispatchEvent(new CustomEvent("piora:open-agent-browser", { detail: { sessionId } }));
  }, [isWaiting, sessionId, visible, wait]);
  useEffect(() => { onWaitingChange?.(isWaiting); return () => onWaitingChange?.(false); }, [isWaiting, onWaitingChange]);
  if (!snapshot || snapshot.id !== sessionId) return null;
  const data = snapshot?.data;
  const waiting = data?.wait?.backend === "desktop";
  const outcome = data?.outcome;
  if (login) return null;
  if (!waiting && outcome?.purpose === "login") return null;
  if (!waiting && (!outcome || (snapshot?.receivedAt ?? 0) - outcome.endedAt > 60_000)) return null;
  const result = outcome?.status === "continued" ? t("browser.waitContinued")
    : outcome?.status === "timeout" ? t("browser.waitTimeout")
    : outcome?.status === "aborted" ? t("browser.waitAborted") : t("browser.waitCancelled");
  return <aside role="status" aria-live="polite" className="browser-handoff-notice" style={{ margin: "8px 16px", padding: "12px 16px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)" }}>
    {waiting && <strong>{t("browser.waitTitle")}</strong>}
    <p>{waiting ? t("browser.waitInstructions") : result}</p>
    {waiting && data?.wait?.reason ? <p>{data.wait.reason}</p> : null}
  </aside>;
}
