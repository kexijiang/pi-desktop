import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const chatHistoryClient = await createJiti(import.meta.url).import("./chat-history-client.ts");
const source = await readFile(new URL("./session-prefetch.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(respond) {
  const requests = [];
  let now = 0;
  const context = { exports: {}, AbortController, Date: { now: () => now }, window: { setTimeout() {}, clearTimeout() {} },
    require: name => {
      assert.equal(name, "./chat-history-client");
      return chatHistoryClient;
    },
    fetch: async (url, options) => { requests.push({ url, options }); return respond(url, options); } };
  vm.runInNewContext(compiled, context);
  return { ...context.exports, requests, advance: ms => { now += ms; } };
}

test("a completed history can seed the first render using the sidebar or response version", async () => {
  let releaseHistory;
  const h = harness(() => new Promise(resolve => { releaseHistory = resolve; }));
  const session = { id: "cold", modified: "sidebar-version" };
  h.prefetchSession(session);
  const loading = h.takePrefetchedSession(session);
  assert.equal(h.requests.length, 1, "click shares the in-flight hover request");
  assert.equal(new URL(h.requests[0].url, "http://local").searchParams.get("view"), "transcript");
  assert.equal(h.peekPrefetchedSession(session), null);
  releaseHistory(Response.json({ context: { messages: [{ role: "user", content: "latest" }] }, info: { modified: "fresh-version" } }));
  const snapshot = await loading;
  h.cancelPendingSessionPrefetch(session.id);
  assert.equal(h.peekPrefetchedSession(session), snapshot.data);
  assert.equal(h.peekPrefetchedSession({ ...session, modified: "fresh-version" }), snapshot.data);
  assert.equal(h.peekPrefetchedSession({ ...session, modified: "newer-version" }), null);
});

test("paints retained history after the hover timeout and conditionally revalidates it", async () => {
  const session = { id: "recent", modified: "one" };
  const h = harness((_url, options) => options.headers?.["If-None-Match"]
    ? new Response(null, { status: 304 })
    : Response.json({ sessionId: session.id, context: { messages: [{ role: "user", content: "latest" }] } }, { headers: { etag: '"v1"' } }));
  const first = await h.takePrefetchedSession(session);
  h.retainSessionHistory(session.id, first);
  h.advance(60_000);
  const newer = { ...session, modified: "two" };
  assert.equal(h.peekSessionHistory(newer), first.data);
  h.prefetchSession(newer);
  assert.equal(h.requests.length, 1, "warm history needs no speculative request");
  const refresh = h.takePrefetchedSession(newer);
  assert.equal(h.peekSessionHistory(newer), first.data);
  assert.equal(h.requests[1].options.headers["If-None-Match"], '"v1"');
  assert.equal(await refresh, first, "304 preserves the already parsed snapshot");
  h.forgetSessionHistory(session.id);
  assert.equal(h.peekSessionHistory(session), null);
});

test("keeps ten recently viewed histories and evicts by count and bytes", async () => {
  const h = harness(() => Response.json({ context: { messages: [] } }));
  const sessions = Array.from({ length: 11 }, (_, i) => ({ id: String(i), modified: "one" }));
  for (const session of sessions.slice(0, 10)) h.retainSessionHistory(session.id, await h.takePrefetchedSession(session));
  h.advance(60_000);
  for (const session of sessions.slice(0, 10)) assert.ok(h.peekSessionHistory(session));

  await h.takePrefetchedSession(sessions[0]);
  h.retainSessionHistory(sessions[10].id, await h.takePrefetchedSession(sessions[10]));
  assert.ok(h.peekSessionHistory(sessions[0]), "revisiting a session renews its recency");
  assert.equal(h.peekSessionHistory(sessions[1]), null);

  const large = { id: "large", modified: "one" };
  const snapshot = await h.takePrefetchedSession(large);
  h.retainSessionHistory(large.id, { ...snapshot, byteLength: 16 * 1024 * 1024 + 1 });
  h.cancelSessionPrefetch(large.id);
  h.invalidatePrefetchedSession(large.id);
  assert.equal(h.peekSessionHistory(large), null);
  assert.ok(h.peekSessionHistory(sessions[10]), "oversized history does not flush useful snapshots");
  const another = { id: "fits", modified: "one" };
  h.retainSessionHistory(another.id, { ...snapshot, byteLength: 16 * 1024 * 1024 });
  assert.ok(h.peekSessionHistory(another));
  assert.equal(h.peekSessionHistory(sessions[10]), null, "combined retained bytes are bounded");
});

test("leaving a loading chat aborts its pending history and ignores the late response", async () => {
  let releaseHistory;
  const h = harness(() => new Promise(resolve => { releaseHistory = resolve; }));
  const session = { id: "leaving", modified: "one" };
  const first = h.takePrefetchedSession(session);
  h.cancelPendingSessionPrefetch(session.id);
  assert.equal(h.requests[0].options.signal.aborted, true);
  releaseHistory(Response.json({ sessionId: session.id, context: { messages: [] } }));
  assert.equal(await first, null);
  assert.equal(h.peekPrefetchedSession(session), null);
});

test("a failed history or a response for a different chat never becomes a usable snapshot", async () => {
  const session = { id: "offline", modified: "one" };
  for (const response of [
    new Response("offline", { status: 503 }),
    Response.json({ info: { id: "unrelated" }, context: { messages: [] } }),
    Response.json({ sessionId: "unrelated", context: { messages: [] } }),
  ]) {
    const h = harness(() => response);
    assert.equal(await h.takePrefetchedSession(session), null);
    assert.equal(h.peekPrefetchedSession(session), null);
  }
});
