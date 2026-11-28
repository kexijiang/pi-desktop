"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./useI18n";
import { classifyWorkflowLoadException, parseWorkflowLoadResponseError } from "@/lib/workflow-client-error";
import {
  cacheWorkflowSnapshot,
  clearWorkflowSnapshotCache,
  peekWorkflowSnapshot,
  pickNewerWorkflowSnapshot,
  shouldAcceptWorkflowSnapshot,
} from "@/lib/workflow/client-cache";
import type { WorkflowAction, WorkflowCriterion, WorkflowMode, WorkflowSnapshot } from "@/lib/workflow-types";

const WORKFLOW_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const INITIAL_LOAD_FAILURE_LIMIT = 3;

export interface WorkflowActionExtra {
  turnBudget?: number;
  objective?: string;
  criteria?: WorkflowCriterion[];
  planMarkdown?: string;
  feedback?: string;
}

/** Session and revision checks fence slow requests after switching chats or acting. */
export function useWorkflow(
  sessionId: string | null,
  visible: boolean,
  running: boolean,
  executeAction: (action: WorkflowAction) => Promise<WorkflowSnapshot>,
  liveSnapshot?: WorkflowSnapshot | null,
  deferInitialLoad = false,
  liveCorrupt = false,
) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(() => (
    liveCorrupt
      ? null
      : pickNewerWorkflowSnapshot(sessionId, peekWorkflowSnapshot(sessionId), liveSnapshot)
  ));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ sessionId, visible, deferInitialLoad, executeAction, liveSnapshot, liveCorrupt, t });
  latest.current = { sessionId, visible, deferInitialLoad, executeAction, liveSnapshot, liveCorrupt, t };
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const acceptedSnapshot = useRef<WorkflowSnapshot | null>(snapshot);
  // Warm client cache is optimistic paint only; wait for an accepted authoritative read.
  const lastReadAt = useRef<number | null>(null);
  const readFailures = useRef(0);
  const lastLoggedFailure = useRef<string | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const accept = useCallback((next: WorkflowSnapshot, options?: { force?: boolean; authoritative?: boolean }): boolean => {
    const sid = latest.current.sessionId;
    if (!sid || next.sessionId !== sid) return false;
    if (!options?.force && !shouldAcceptWorkflowSnapshot(acceptedSnapshot.current, next, sid)) {
      return false;
    }
    const stored = cacheWorkflowSnapshot(next, { force: options?.force });
    acceptedSnapshot.current = stored;
    if (options?.authoritative !== false) {
      lastReadAt.current = Date.now();
      readFailures.current = 0;
    }
    lastLoggedFailure.current = null;
    setSnapshot(stored);
    setLoadError(null);
    setLoadErrorCode(null);
    return true;
  }, []);

  const reconcile = useCallback(async function readWorkflow(explicit = false) {
    const { sessionId: sid, visible, deferInitialLoad } = latest.current;
    if (!sid || request.current || (!explicit && deferInitialLoad)) return;
    if (!explicit && (!visible || document.visibilityState === "hidden" || retryTimer.current !== null)) return;
    clearRetry();
    const epoch = generation.current;
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () => epoch === generation.current && !controller.signal.aborted && latest.current.sessionId === sid;
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/workflow`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw await parseWorkflowLoadResponseError(response, latest.current.t);
      const next = await response.json() as WorkflowSnapshot | null;
      if (!isCurrent()) return;
      if (!next || next.sessionId !== sid || !Number.isSafeInteger(next.revision)
        || !["agent", "plan", "goal"].includes(next.mode) || !Array.isArray(next.history)) {
        throw new Error(latest.current.t("workflow.loadError"));
      }
      accept(next, { authoritative: true });
    } catch (cause) {
      if (!isCurrent()) return;
      const failure = classifyWorkflowLoadException(cause, latest.current.t);
      const signature = `${sid}:${failure.status ?? ""}:${failure.code ?? ""}:${failure.rawMessage ?? ""}`;
      if (explicit || lastLoggedFailure.current !== signature) {
        lastLoggedFailure.current = signature;
        console.warn("[workflow] load failed", {
          sid,
          status: failure.status,
          code: failure.code,
          retryable: failure.retryable,
          message: failure.rawMessage ?? failure.message,
        });
      }
      const failures = ++readFailures.current;
      if (!failure.retryable) {
        if (failure.code === "WORKFLOW_STATE_CORRUPT") {
          clearWorkflowSnapshotCache(sid);
          acceptedSnapshot.current = null;
          lastReadAt.current = null;
          setSnapshot(null);
        }
        setLoadError(failure.message);
        setLoadErrorCode(failure.code ?? null);
        return;
      }
      // Keep the last usable state during a failed background read.
      if (acceptedSnapshot.current?.sessionId !== sid && failures >= INITIAL_LOAD_FAILURE_LIMIT) {
        setLoadError(failure.message);
        setLoadErrorCode(failure.code ?? null);
      }
      const delay = WORKFLOW_RETRY_DELAYS[Math.min(failures - 1, WORKFLOW_RETRY_DELAYS.length - 1)];
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        void readWorkflow();
      }, delay);
    } finally { if (request.current === controller) request.current = null; }
  }, [accept, clearRetry]);

  const refresh = useCallback(async () => {
    // An explicit retry acknowledges the previous action failure. Background
    // polling only reconciles state and must not erase the failure message.
    setActionError(null);
    await reconcile(true);
  }, [reconcile]);

  const resetCorrupt = useCallback(async () => {
    const sid = latest.current.sessionId;
    if (!sid || actionInFlight.current) return false;
    const epoch = generation.current;
    actionInFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_corrupt" }),
      });
      const result = await response.json() as { snapshot?: WorkflowSnapshot; error?: string };
      if (!response.ok || !result.snapshot) {
        throw new Error(result.error ?? latest.current.t("workflow.actionError"));
      }
      if (epoch !== generation.current || latest.current.sessionId !== sid) return false;
      // Invalidate any in-flight reads sampled before the reset completed.
      generation.current = epoch + 1;
      request.current?.abort();
      request.current = null;
      clearRetry();
      clearWorkflowSnapshotCache(sid);
      acceptedSnapshot.current = null;
      accept(result.snapshot, { force: true, authoritative: true });
      return true;
    } catch (cause) {
      if (epoch === generation.current && latest.current.sessionId === sid) {
        setActionError(cause instanceof Error ? cause.message : latest.current.t("workflow.actionError"));
      }
      return false;
    } finally {
      if (latest.current.sessionId === sid) { actionInFlight.current = false; setBusy(false); }
    }
  }, [accept, clearRetry]);

  useEffect(() => {
    const epoch = ++generation.current;
    const live = latest.current.liveSnapshot;
    const initial = latest.current.liveCorrupt
      ? null
      : pickNewerWorkflowSnapshot(sessionId, peekWorkflowSnapshot(sessionId), live);
    acceptedSnapshot.current = initial;
    lastReadAt.current = null;
    readFailures.current = 0;
    lastLoggedFailure.current = null;
    actionInFlight.current = false;
    setSnapshot(initial); setLoadError(null); setLoadErrorCode(null); setActionError(null); setBusy(false);
    return () => {
      generation.current = epoch + 1;
      request.current?.abort();
      request.current = null;
      clearRetry();
    };
  }, [sessionId, clearRetry]);

  useEffect(() => {
    if (!sessionId || !liveCorrupt) return;
    clearWorkflowSnapshotCache(sessionId);
    acceptedSnapshot.current = null;
    lastReadAt.current = null;
    setSnapshot(null);
    void reconcile(true);
  }, [liveCorrupt, sessionId, reconcile]);

  useEffect(() => {
    if (!liveCorrupt && liveSnapshot && liveSnapshot.sessionId === sessionId) {
      accept(liveSnapshot, { authoritative: true });
    }
  }, [liveCorrupt, liveSnapshot, sessionId, accept]);

  const hasActiveWorkflow = Boolean(snapshot?.sessionId === sessionId && (snapshot.mode !== "agent" || snapshot.current));

  useEffect(() => {
    if (!sessionId || !visible || deferInitialLoad) return;
    const refreshVisible = () => {
      if (readFailures.current > 0 || lastReadAt.current === null || Date.now() - lastReadAt.current >= 5_000) void reconcile();
    };
    refreshVisible();
    const pollMs = hasActiveWorkflow ? (running ? 5_000 : 15_000) : (running ? 30_000 : 0);
    const timer = pollMs > 0 ? setInterval(() => {
      void reconcile();
    }, pollMs) : null;
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener("online", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [sessionId, visible, running, hasActiveWorkflow, deferInitialLoad, reconcile]);

  const act = useCallback(async (
    action: WorkflowAction["action"],
    extra?: number | WorkflowActionExtra,
  ) => {
    const current = snapshot;
    if (!current?.current || current.sessionId !== latest.current.sessionId || actionInFlight.current) return false;
    const epoch = generation.current;
    const options: WorkflowActionExtra = typeof extra === "number" ? { turnBudget: extra } : (extra ?? {});
    actionInFlight.current = true; setBusy(true); setLoadError(null); setActionError(null);
    try {
      const next = await latest.current.executeAction({
        action,
        runId: current.current.id,
        expectedRevision: current.revision,
        ...(options.turnBudget !== undefined ? { turnBudget: options.turnBudget } : {}),
        ...(options.objective !== undefined ? { objective: options.objective } : {}),
        ...(options.criteria !== undefined ? { criteria: options.criteria } : {}),
        ...(options.planMarkdown !== undefined ? { planMarkdown: options.planMarkdown } : {}),
        ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
      });
      if (epoch !== generation.current) return false;
      accept(next);
      return true;
    } catch (cause) {
      if (epoch === generation.current) {
        setActionError(cause instanceof Error ? cause.message : latest.current.t("workflow.actionError"));
        // A 409 may mean another window acted; reload before offering actions.
        void reconcile(true);
      }
      return false;
    } finally {
      if (epoch === generation.current) { actionInFlight.current = false; setBusy(false); }
    }
  }, [snapshot, accept, reconcile]);

  const configureMode = useCallback(async (mode: WorkflowMode, turnBudget?: number) => {
    const sid = latest.current.sessionId;
    const current = snapshot;
    if (!sid || !current || current.sessionId !== sid || actionInFlight.current) return false;
    const epoch = generation.current;
    actionInFlight.current = true; setBusy(true); setLoadError(null); setActionError(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "configure",
          mode,
          ...(turnBudget !== undefined ? { turnBudget } : {}),
          expectedRevision: current.revision,
        }),
      });
      const result = await response.json() as { snapshot?: WorkflowSnapshot; error?: string };
      if (!response.ok || !result.snapshot) {
        throw new Error(result.error ?? latest.current.t("workflow.actionError"));
      }
      if (epoch !== generation.current) return false;
      accept(result.snapshot);
      return true;
    } catch (cause) {
      if (epoch === generation.current) {
        setActionError(cause instanceof Error ? cause.message : latest.current.t("workflow.actionError"));
        void reconcile(true);
      }
      return false;
    } finally {
      if (epoch === generation.current) { actionInFlight.current = false; setBusy(false); }
    }
  }, [snapshot, accept, reconcile]);

  const savePlanMarkdown = useCallback(async (runId: string, markdown: string) => {
    const sid = latest.current.sessionId;
    if (!sid || actionInFlight.current) return false;
    const epoch = generation.current;
    actionInFlight.current = true; setBusy(true); setLoadError(null); setActionError(null);
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/workflow/plan`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          markdown,
          ...(snapshot?.sessionId === sid ? { expectedRevision: snapshot.revision } : {}),
        }),
      });
      const result = await response.json() as { snapshot?: WorkflowSnapshot; error?: string };
      if (!response.ok || !result.snapshot) {
        throw new Error(result.error ?? latest.current.t("workflow.actionError"));
      }
      if (epoch !== generation.current) return false;
      accept(result.snapshot);
      return true;
    } catch (cause) {
      if (epoch === generation.current) {
        setActionError(cause instanceof Error ? cause.message : latest.current.t("workflow.actionError"));
        void reconcile(true);
      }
      return false;
    } finally {
      if (epoch === generation.current) { actionInFlight.current = false; setBusy(false); }
    }
  }, [snapshot, accept, reconcile]);

  return {
    snapshot: snapshot?.sessionId === sessionId ? snapshot : null,
    error: actionError ?? loadError,
    loadErrorCode: actionError ? null : loadErrorCode,
    busy,
    act,
    configureMode,
    savePlanMarkdown,
    accept,
    refresh,
    resetCorrupt,
  };
}
