import type { WorkflowSnapshot } from "@/lib/workflow-types";

const MAX_CACHED_WORKFLOWS = 64;
const workflowSnapshotCache = new Map<string, WorkflowSnapshot>();

export function isValidWorkflowSnapshot(value: unknown, sessionId?: string | null): value is WorkflowSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkflowSnapshot>;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId) return false;
  if (sessionId && candidate.sessionId !== sessionId) return false;
  if (candidate.resetAt !== undefined && (!Number.isSafeInteger(candidate.resetAt) || candidate.resetAt < 0)) {
    return false;
  }
  if (candidate.transientSeq !== undefined && (!Number.isSafeInteger(candidate.transientSeq) || candidate.transientSeq < 0)) {
    return false;
  }
  return Number.isSafeInteger(candidate.revision)
    && (candidate.mode === "agent" || candidate.mode === "plan" || candidate.mode === "goal")
    && Array.isArray(candidate.history);
}

/**
 * Total ordering for workflow snapshots of the same session:
 * 1. resetAt generation (higher always supersedes pre-reset higher revisions)
 * 2. durable revision
 * 3. transientSeq within the same revision (e.g. clearing autoContinuing in beginTurn)
 */
export function compareWorkflowSnapshots(a: WorkflowSnapshot, b: WorkflowSnapshot): number {
  const resetDiff = (a.resetAt ?? 0) - (b.resetAt ?? 0);
  if (resetDiff !== 0) return resetDiff;
  const revDiff = a.revision - b.revision;
  if (revDiff !== 0) return revDiff;
  return (a.transientSeq ?? 0) - (b.transientSeq ?? 0);
}

export function shouldAcceptWorkflowSnapshot(
  current: WorkflowSnapshot | null | undefined,
  incoming: WorkflowSnapshot | null | undefined,
  sessionId?: string | null,
): incoming is WorkflowSnapshot {
  if (!isValidWorkflowSnapshot(incoming, sessionId)) return false;
  if (!current || current.sessionId !== incoming.sessionId) return true;
  return compareWorkflowSnapshots(incoming, current) >= 0;
}

export function mergeWorkflowSnapshot(
  current: WorkflowSnapshot | null | undefined,
  incoming: WorkflowSnapshot | null | undefined,
  sessionId?: string | null,
): WorkflowSnapshot | null {
  const validCurrent = isValidWorkflowSnapshot(current, sessionId) ? current : null;
  if (!shouldAcceptWorkflowSnapshot(validCurrent, incoming, sessionId)) {
    return validCurrent;
  }
  return incoming;
}

export function peekWorkflowSnapshot(sessionId: string | null | undefined): WorkflowSnapshot | null {
  if (!sessionId) return null;
  const cached = workflowSnapshotCache.get(sessionId);
  if (!cached) return null;
  // Refresh LRU recency.
  workflowSnapshotCache.delete(sessionId);
  workflowSnapshotCache.set(sessionId, cached);
  return cached;
}

export function cacheWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
  options?: { force?: boolean },
): WorkflowSnapshot {
  if (!isValidWorkflowSnapshot(snapshot)) return snapshot;
  const existing = workflowSnapshotCache.get(snapshot.sessionId);
  if (!options?.force && existing && compareWorkflowSnapshots(snapshot, existing) < 0) {
    return existing;
  }
  workflowSnapshotCache.delete(snapshot.sessionId);
  workflowSnapshotCache.set(snapshot.sessionId, snapshot);
  while (workflowSnapshotCache.size > MAX_CACHED_WORKFLOWS) {
    const oldest = workflowSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    workflowSnapshotCache.delete(oldest);
  }
  return snapshot;
}

export function pickNewerWorkflowSnapshot(
  sessionId: string | null | undefined,
  ...candidates: Array<WorkflowSnapshot | null | undefined>
): WorkflowSnapshot | null {
  if (!sessionId) return null;
  let best: WorkflowSnapshot | null = null;
  for (const candidate of candidates) {
    if (!isValidWorkflowSnapshot(candidate, sessionId)) continue;
    if (!best || compareWorkflowSnapshots(candidate, best) >= 0) {
      best = candidate;
    }
  }
  return best;
}

export function clearWorkflowSnapshotCache(sessionId?: string): void {
  if (sessionId) workflowSnapshotCache.delete(sessionId);
  else workflowSnapshotCache.clear();
}
