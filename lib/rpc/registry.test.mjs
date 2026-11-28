import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const registry = await jiti.import("./registry.ts");

function createStubSession(id, cwd, { alive = true, running = false, lastActivityAt = Date.now(), mcpTransportCount = 0 } = {}) {
  let isAlive = alive;
  let destroyed = 0;
  let destroyReason;
  let refreshedApprovals = 0;
  return {
    sessionId: id,
    cwd,
    projectRoot: cwd,
    runtimeProfile: "normal",
    lastActivityAt,
    nativeMcp: mcpTransportCount > 0 ? { activeTransportCount: mcpTransportCount } : undefined,
    inner: { sessionManager: { getHeader: () => null, getEntries: () => [], getSessionName: () => undefined } },
    isAlive: () => isAlive,
    isRunning: () => isAlive && running,
    isSubagentSession: () => false,
    destroy: (reason) => {
      destroyed += 1;
      destroyReason = reason;
      isAlive = false;
    },
    shutdownForFileMutation: async () => {},
    refreshToolApprovals: () => { refreshedApprovals += 1; },
    get destroyedCount() { return destroyed; },
    get destroyReason() { return destroyReason; },
    get refreshedApprovalsCount() { return refreshedApprovals; },
  };
}

test("registry tracks live sessions, busy cwds, starting cwds, and bulk cleanup", () => {
  const map = registry.getRegistry();
  const s1 = createStubSession("reg-test-1", process.cwd(), { running: true });
  const s2 = createStubSession("reg-test-2", process.cwd(), { running: false });
  map.set(s1.sessionId, s1);
  map.set(s2.sessionId, s2);
  try {
    assert.equal(registry.getRpcSession("reg-test-1"), s1);
    assert.equal(registry.hasBusyRpcSessionForCwd(process.cwd()), true);

    registry.refreshLiveToolApprovals();
    assert.equal(s1.refreshedApprovalsCount, 1);
    assert.equal(s2.refreshedApprovalsCount, 1);

    const destroyed = registry.destroyRpcSessionsForCwd(process.cwd());
    assert.ok(destroyed >= 2);
    assert.equal(s1.destroyedCount, 1);
    assert.equal(s2.destroyedCount, 1);
    assert.equal(registry.hasBusyRpcSessionForCwd(process.cwd()), false);

    const releaseStart = registry.trackStartingSession(process.cwd());
    assert.equal(registry.hasBusyRpcSessionForCwd(process.cwd()), true);
    releaseStart();
    assert.equal(registry.hasBusyRpcSessionForCwd(process.cwd()), false);
  } finally {
    map.delete(s1.sessionId);
    map.delete(s2.sessionId);
  }
});

test("invalidateServicesCache clears cached session service entries", () => {
  const cache = registry.getServicesCache();
  cache.set("normal:test-cache-key", { settingsManager: {} });
  assert.equal(cache.has("normal:test-cache-key"), true);
  registry.invalidateServicesCache();
  assert.equal(cache.size, 0);
});

test("evictIdleRpcSessions evicts oldest idle sessions beyond limit while preserving running and excluded sessions", async () => {
  const map = registry.getRegistry();
  const sOldest = createStubSession("evict-oldest", process.cwd(), { running: false, lastActivityAt: 100 });
  const sMid = createStubSession("evict-mid", process.cwd(), { running: false, lastActivityAt: 200 });
  const sNewest = createStubSession("evict-newest", process.cwd(), { running: false, lastActivityAt: 300 });
  const sRunning = createStubSession("evict-running", process.cwd(), { running: true, lastActivityAt: 50 });
  const sExcluded = createStubSession("evict-excluded", process.cwd(), { running: false, lastActivityAt: 10 });
  for (const s of [sOldest, sMid, sNewest, sRunning, sExcluded]) map.set(s.sessionId, s);
  try {
    await registry.evictIdleRpcSessions("evict-excluded", 1);
    assert.equal(sOldest.destroyedCount, 1);
    assert.equal(sOldest.destroyReason, "lru_eviction");
    assert.equal(sMid.destroyedCount, 1);
    assert.equal(sNewest.destroyedCount, 0);
    assert.equal(sRunning.destroyedCount, 0);
    assert.equal(sExcluded.destroyedCount, 0);
  } finally {
    for (const s of [sOldest, sMid, sNewest, sRunning, sExcluded]) map.delete(s.sessionId);
  }
});

test("evictOldestIdleMcpSession evicts only the oldest idle session holding MCP transports", async () => {
  const map = registry.getRegistry();
  const sNoMcp = createStubSession("mcp-evict-none", process.cwd(), { running: false, lastActivityAt: 10, mcpTransportCount: 0 });
  const sRunningMcp = createStubSession("mcp-evict-run", process.cwd(), { running: true, lastActivityAt: 20, mcpTransportCount: 2 });
  const sIdleOldMcp = createStubSession("mcp-evict-old", process.cwd(), { running: false, lastActivityAt: 30, mcpTransportCount: 1 });
  const sIdleNewMcp = createStubSession("mcp-evict-new", process.cwd(), { running: false, lastActivityAt: 40, mcpTransportCount: 1 });
  for (const s of [sNoMcp, sRunningMcp, sIdleOldMcp, sIdleNewMcp]) map.set(s.sessionId, s);
  try {
    const first = await registry.evictOldestIdleMcpSession();
    assert.equal(first, true);
    assert.equal(sIdleOldMcp.destroyedCount, 1);
    assert.equal(sIdleOldMcp.destroyReason, "lru_eviction");
    assert.equal(sIdleNewMcp.destroyedCount, 0);
    assert.equal(sNoMcp.destroyedCount, 0);
    assert.equal(sRunningMcp.destroyedCount, 0);

    const second = await registry.evictOldestIdleMcpSession();
    assert.equal(second, true);
    assert.equal(sIdleNewMcp.destroyedCount, 1);

    const third = await registry.evictOldestIdleMcpSession();
    assert.equal(third, false);
  } finally {
    for (const s of [sNoMcp, sRunningMcp, sIdleOldMcp, sIdleNewMcp]) map.delete(s.sessionId);
  }
});
