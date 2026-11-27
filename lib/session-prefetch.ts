import type { SessionInfo } from "./types";
import { chatHistoryUrl, isSessionChatHistory, readChatHistorySnapshot, type ChatHistorySnapshot, type SessionData } from "./chat-history-client";

const PREFETCH_TTL_MS = 30_000;
const MAX_PREFETCH_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_RECENT_SESSION_COUNT = 10;
const MAX_RECENT_SESSION_BYTES = 16 * 1024 * 1024;

interface PrefetchEntry {
  sessionId: string;
  modified: string;
  requestedModified: string;
  createdAt: number;
  lastAccessedAt: number;
  byteLength: number;
  settled: boolean;
  cancelOnLeave: boolean;
  controller: AbortController;
  promise: Promise<ChatHistorySnapshot | null>;
  snapshot?: ChatHistorySnapshot;
  expiryTimer?: number;
}

const prefetchedSessions = new Map<string, PrefetchEntry>();
let activePrefetch: PrefetchEntry | null = null;
let cachedPrefetchBytes = 0;
const recentSessions = new Map<string, ChatHistorySnapshot>();
let recentSessionBytes = 0;

function removePrefetch(entry: PrefetchEntry, abort = false): void {
  if (prefetchedSessions.get(entry.sessionId) !== entry) return;
  prefetchedSessions.delete(entry.sessionId);
  if (entry.expiryTimer !== undefined) window.clearTimeout(entry.expiryTimer);
  cachedPrefetchBytes = Math.max(0, cachedPrefetchBytes - entry.byteLength);
  if (abort && !entry.settled) entry.controller.abort();
  if (activePrefetch === entry) activePrefetch = null;
}

function prunePrefetchedSessions(now = Date.now()): void {
  for (const entry of prefetchedSessions.values()) {
    if (now - entry.createdAt >= PREFETCH_TTL_MS) removePrefetch(entry, true);
  }
  while (cachedPrefetchBytes > MAX_PREFETCH_CACHE_BYTES) {
    let oldest: PrefetchEntry | null = null;
    for (const candidate of prefetchedSessions) {
      const entry = candidate[1];
      if (!entry.settled || entry.byteLength === 0) continue;
      if (!oldest || entry.lastAccessedAt < oldest.lastAccessedAt) oldest = entry;
    }
    if (!oldest) break;
    removePrefetch(oldest);
  }
}

function createPrefetch(
  session: Pick<SessionInfo, "id" | "modified">,
  cancelOnLeave: boolean,
): PrefetchEntry {
  if (activePrefetch && activePrefetch.sessionId !== session.id) {
    removePrefetch(activePrefetch, true);
  }
  const createdAt = Date.now();
  const controller = new AbortController();
  const retained = recentSessions.get(session.id);
  const entry: PrefetchEntry = {
    sessionId: session.id,
    modified: session.modified,
    requestedModified: session.modified,
    createdAt,
    lastAccessedAt: createdAt,
    byteLength: 0,
    settled: false,
    cancelOnLeave,
    controller,
    promise: Promise.resolve(null),
  };
  entry.promise = fetch(chatHistoryUrl(session.id), {
    signal: controller.signal,
    ...(retained?.etag ? { cache: "no-store", headers: { "If-None-Match": retained.etag } } : {}),
  })
      .then(async (response) => {
        const snapshot = response.status === 304 ? retained : response.ok ? await readChatHistorySnapshot(response, controller.signal) : null;
        if (controller.signal.aborted || !snapshot || !isSessionChatHistory(snapshot.data, session.id)) return null;
        entry.byteLength = snapshot === retained ? 0 : snapshot.byteLength;
        cachedPrefetchBytes += entry.byteLength;
        entry.snapshot = snapshot;
        // The sidebar may lag behind this response. Keep both versions until
        // the sidebar publishes a different one.
        if (typeof snapshot.data.info?.modified === "string") entry.modified = snapshot.data.info.modified;
        return snapshot;
      })
      .catch(() => null)
      .finally(() => {
        entry.settled = true;
        if (activePrefetch === entry) activePrefetch = null;
        prunePrefetchedSessions();
      });
  prunePrefetchedSessions(createdAt);
  prefetchedSessions.set(session.id, entry);
  activePrefetch = entry;
  void entry.promise.then((data) => {
    if (!data) removePrefetch(entry);
  });
  entry.expiryTimer = window.setTimeout(() => {
    removePrefetch(entry, true);
  }, PREFETCH_TTL_MS);
  return entry;
}

export function prefetchSession(
  session: Pick<SessionInfo, "id" | "modified">,
  options: { keepOnMouseLeave?: boolean } = {},
): void {
  prunePrefetchedSessions();
  if (recentSessions.has(session.id)) return;
  if (
    activePrefetch
    && activePrefetch.sessionId !== session.id
    && !activePrefetch.cancelOnLeave
    && !options.keepOnMouseLeave
  ) {
    return;
  }
  const existing = prefetchedSessions.get(session.id);
  if (existing && matchesVersion(existing, session.modified) && Date.now() - existing.createdAt < PREFETCH_TTL_MS) {
    existing.lastAccessedAt = Date.now();
    if (options.keepOnMouseLeave) existing.cancelOnLeave = false;
    return;
  }
  if (existing) removePrefetch(existing, true);
  void createPrefetch(session, !options.keepOnMouseLeave).promise;
}

export function cancelSessionPrefetch(sessionId: string): void {
  const entry = prefetchedSessions.get(sessionId);
  if (entry?.cancelOnLeave) removePrefetch(entry, true);
}

export function cancelPendingSessionPrefetch(sessionId: string): void {
  const entry = prefetchedSessions.get(sessionId);
  if (entry && !entry.settled) removePrefetch(entry, true);
}

function matchesVersion(entry: PrefetchEntry, modified: string): boolean {
  return entry.modified === modified || entry.requestedModified === modified;
}

export function takePrefetchedSession(
  session: Pick<SessionInfo, "id" | "modified">,
): Promise<ChatHistorySnapshot | null> {
  prunePrefetchedSessions();
  const recent = recentSessions.get(session.id);
  if (recent) {
    recentSessions.delete(session.id);
    recentSessions.set(session.id, recent);
  }
  const entry = prefetchedSessions.get(session.id);
  if (!entry || (recent && entry.settled) || !matchesVersion(entry, session.modified)) {
    if (entry) removePrefetch(entry, true);
    return createPrefetch(session, false).promise;
  }
  entry.lastAccessedAt = Date.now();
  entry.cancelOnLeave = false;
  return entry.promise;
}

/**
 * Returns a completed, version-matched switch snapshot without scheduling any
 * asynchronous work. This lets the newly mounted chat render its first frame
 * from the pointer/hover prefetch instead of flashing a full loading screen.
 */
export function peekPrefetchedSession(
  session: Pick<SessionInfo, "id" | "modified">,
): SessionData | null {
  const entry = prefetchedSessions.get(session.id);
  if (
    !entry
    || !entry.settled
    || !entry.snapshot
    || !matchesVersion(entry, session.modified)
    || Date.now() - entry.createdAt >= PREFETCH_TTL_MS
  ) {
    return null;
  }
  return entry.snapshot.data;
}

export function invalidatePrefetchedSession(sessionId: string): void {
  const entry = prefetchedSessions.get(sessionId);
  if (entry) removePrefetch(entry, true);
}

export function peekSessionHistory(session: Pick<SessionInfo, "id" | "modified">): SessionData | null {
  return recentSessions.get(session.id)?.data ?? peekPrefetchedSession(session);
}

function removeRecentSession(sessionId: string): void {
  const entry = recentSessions.get(sessionId);
  if (!entry) return;
  recentSessions.delete(sessionId);
  recentSessionBytes -= entry.byteLength;
}

export function retainSessionHistory(sessionId: string, snapshot: ChatHistorySnapshot): void {
  const prefetch = prefetchedSessions.get(sessionId);
  if (prefetch?.snapshot === snapshot) removePrefetch(prefetch);
  removeRecentSession(sessionId);
  if (snapshot.byteLength > MAX_RECENT_SESSION_BYTES) return;
  recentSessions.set(sessionId, snapshot);
  recentSessionBytes += snapshot.byteLength;
  while (recentSessions.size > MAX_RECENT_SESSION_COUNT || recentSessionBytes > MAX_RECENT_SESSION_BYTES) {
    removeRecentSession(recentSessions.keys().next().value!);
  }
}

export function forgetSessionHistory(sessionId: string): void {
  invalidatePrefetchedSession(sessionId);
  removeRecentSession(sessionId);
}
