import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  cacheWorkflowSnapshot,
  clearWorkflowSnapshotCache,
  compareWorkflowSnapshots,
  mergeWorkflowSnapshot,
  peekWorkflowSnapshot,
  pickNewerWorkflowSnapshot,
  shouldAcceptWorkflowSnapshot,
} = await jiti.import("./client-cache.ts");

function makeSnapshot(sessionId, revision, extra = {}) {
  return { sessionId, revision, mode: "goal", turnBudget: 10, current: null, history: [], ...extra };
}

test("workflow client cache preserves monotonic revisions and picks newest snapshot", () => {
  clearWorkflowSnapshotCache();
  const rev2 = makeSnapshot("s-1", 2);
  const rev1 = makeSnapshot("s-1", 1);
  const rev3 = makeSnapshot("s-1", 3);

  assert.equal(peekWorkflowSnapshot("s-1"), null);
  cacheWorkflowSnapshot(rev2);
  assert.deepEqual(peekWorkflowSnapshot("s-1"), rev2);
  // Stale revision must not overwrite a newer snapshot.
  cacheWorkflowSnapshot(rev1);
  assert.deepEqual(peekWorkflowSnapshot("s-1"), rev2);
  assert.deepEqual(pickNewerWorkflowSnapshot("s-1", rev1, rev2, rev3), rev3);
  assert.equal(pickNewerWorkflowSnapshot("s-1", makeSnapshot("other", 99)), null);
  clearWorkflowSnapshotCache("s-1");
  assert.equal(peekWorkflowSnapshot("s-1"), null);
});

test("reset generation supersedes higher pre-reset revision and rejects stale pre-reset responses", () => {
  clearWorkflowSnapshotCache();
  const preReset = makeSnapshot("s-reset", 7);
  const postReset = makeSnapshot("s-reset", 0, { mode: "agent", resetAt: 1_700_000_000_000 });

  cacheWorkflowSnapshot(preReset);
  assert.ok(compareWorkflowSnapshots(postReset, preReset) > 0);
  assert.equal(shouldAcceptWorkflowSnapshot(preReset, postReset, "s-reset"), true);
  assert.deepEqual(cacheWorkflowSnapshot(postReset), postReset);
  assert.deepEqual(peekWorkflowSnapshot("s-reset"), postReset);

  // Stale in-flight pre-reset response with higher revision must be rejected.
  assert.equal(shouldAcceptWorkflowSnapshot(postReset, preReset, "s-reset"), false);
  assert.deepEqual(cacheWorkflowSnapshot(preReset), postReset);
  assert.deepEqual(mergeWorkflowSnapshot(postReset, preReset, "s-reset"), postReset);
  assert.deepEqual(pickNewerWorkflowSnapshot("s-reset", preReset, postReset), postReset);
  clearWorkflowSnapshotCache("s-reset");
});

test("transientSeq prevents stale same-revision autoContinuing HTTP state from overwriting newer SSE state", () => {
  clearWorkflowSnapshotCache();
  const staleHttp = makeSnapshot("s-seq", 5, { autoContinuing: true });
  const newerSse = makeSnapshot("s-seq", 5, { transientSeq: 1 });

  assert.ok(compareWorkflowSnapshots(newerSse, staleHttp) > 0);
  assert.deepEqual(mergeWorkflowSnapshot(staleHttp, newerSse, "s-seq"), newerSse);
  assert.deepEqual(mergeWorkflowSnapshot(newerSse, staleHttp, "s-seq"), newerSse);
  cacheWorkflowSnapshot(newerSse);
  assert.deepEqual(cacheWorkflowSnapshot(staleHttp), newerSse);
  clearWorkflowSnapshotCache("s-seq");
});
