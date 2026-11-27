import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { requestSessionDeletion } = await jiti.import("./session-delete-client.ts");
const { peekSessionHistory, retainSessionHistory } = await jiti.import("./session-prefetch.ts");

test("failed HTTP responses reject instead of reporting a successful deletion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Disk unavailable" }, { status: 500 }));
  await assert.rejects(requestSessionDeletion("a"), /Disk unavailable/);
});

test("successful deletion returns its affected subtree and removes only those history snapshots", async (t) => {
  for (const sessionId of ["a", "b", "other"]) {
    const data = { sessionId, context: { messages: [] } };
    retainSessionHistory(sessionId, { data, byteLength: 50, etag: null });
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ sessionIds: ["a", "b"], trashedCount: 2 }));
  assert.deepEqual(await requestSessionDeletion("a"), { sessionIds: ["a", "b"], trashedCount: 2 });
  assert.equal(peekSessionHistory({ id: "a" }), null);
  assert.equal(peekSessionHistory({ id: "b" }), null);
  assert.equal(peekSessionHistory({ id: "other" })?.sessionId, "other");
});
