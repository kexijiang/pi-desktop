import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { controlPackagedServer } from "./packaged-node-control.mjs";

/**
 * Measure the real production server child of the isolated Electron copy.
 * The caller supplies its ephemeral desktop token only in memory.
 */
export async function runPackagedColdSweep({
  origin, headers, agentDirectory, cwd, provider, model, serverDirectory, output, pairs = 10, abPairs = 8, createSamples = 5,
}) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const folder = join(agentDirectory, "sessions", "--packaged-perf-cold--");
  await mkdir(folder, { recursive: true });
  const timestamp = new Date().toISOString();
  const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  async function seed(name) {
    const id = randomUUID();
    const entries = [
      { type: "session", version: 3, id, cwd, timestamp },
      { type: "model_change", id: "00000001", parentId: null, timestamp, provider, modelId: model },
      { type: "message", id: "00000002", parentId: "00000001", timestamp, message: { role: "user", content: "Prior fixed context.", timestamp: Date.parse(timestamp) } },
      { type: "message", id: "00000003", parentId: "00000002", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Prior fixed answer." }], provider, model, api: "openai-completions", stopReason: "stop", usage, timestamp: Date.parse(timestamp) } },
      { type: "session_info", id: "00000004", parentId: "00000003", timestamp, name },
    ];
    await writeFile(join(folder, id + ".jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
    return id;
  }
  const modes = ["full", "omit-heavy", "cache-resolve"];
  const safe = Array.from({ length: pairs }, (_, i) => ["cold", "warm"].map(async name => ({ name, id: await seed(name + "-" + i) })));
  const experiment = Array.from({ length: abPairs }, (_, i) => modes.map(async name => ({ name, id: await seed(name + "-" + i) })));
  await Promise.all([...safe, ...experiment].flat());
  const control = body => controlPackagedServer(serverDirectory, body);
  async function json(path, body) {
    const response = await fetch(origin + path, {
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(60_000),
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(path + " HTTP " + response.status + " " + (await response.text()).slice(0, 160));
    return response.json();
  }
  async function connect(id) {
    const start = performance.now(), controller = new AbortController();
    const response = await fetch(origin + "/api/agent/" + id + "/events?transport=delta", {
      headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let queue = "";
    const frames = [];
    async function next(predicate) {
      try {
        while (true) {
          let index;
          while ((index = queue.indexOf("\n\n")) >= 0) {
            const frame = queue.slice(0, index);
            queue = queue.slice(index + 2);
            if (!frame.startsWith("data: ")) continue;
            const event = JSON.parse(frame.slice(6));
            const at = performance.now();
            frames.push(event.type);
            if (predicate(event)) return { at, atMs: Date.now(), elapsedMs: at - start };
            if (event.type === "error" || event.type === "prompt_error") throw new Error("SSE error " + String(event.errorCode ?? event.type));
          }
          const { done, value } = await reader.read();
          if (done) throw new Error("Event stream ended");
          queue += value;
        }
      } catch (error) { throw new Error(id + " frames " + JSON.stringify(frames) + " " + error.message, { cause: error }); }
    }
    return { next, close: () => controller.abort() };
  }
  async function sample(id, name, pair) {
    const path = "/api/agent/" + id;
    assert.equal((await json(path + "?view=progress")).running, false, "Matched session must begin without a wrapper");
    if (name === "warm") {
      const prime = await connect(id);
      try { await prime.next(event => event.type === "connected"); } finally { prime.close(); }
      assert.equal((await json(path + "?view=progress")).running, true);
    }
    const connectStart = performance.now();
    const stream = await connect(id);
    try {
      const connected = await stream.next(event => event.type === "connected");
      const start = performance.now(), postAt = Date.now();
      const pending = json(path, { type: "submit_input", message: "PERF_REQUEST_PACKAGECOLD Measure consistent response timing.", idempotencyKey: randomUUID(), inputMode: "text" });
      const firstText = await stream.next(event => (event.type === "message_delta" && event.field === "text" && event.delta)
        || (event.type === "message_block" && event.block?.type === "text" && event.block.text)
        || (event.message?.role === "assistant" && event.message.content?.some(block => block.type === "text" && block.text)));
      const receipt = await pending;
      assert.equal(receipt.success, true);
      const commandId = receipt.data.commandId;
      const limit = performance.now() + 15_000;
      do {
        const state = await json(path + "?view=progress&promptCommandId=" + commandId);
        if (state.promptCommand?.status === "completed") {
          return { id, name, pair, prewarm: name === "warm", postAt, frameAt: firstText.atMs, connectedMs: connected.elapsedMs,
            postFirstTextMs: firstText.at - start, lifecycleFirstTextMs: firstText.at - connectStart, postDoneMs: performance.now() - start, commandId };
        }
        if (["failed", "cancelled", "expired", "interrupted"].includes(state.promptCommand?.status)) throw new Error("Unexpected terminal result " + state.promptCommand.status);
        await delay(60);
      } while (performance.now() < limit);
      throw new Error("Durable completion was not observed for " + id);
    } finally {
      stream.close();
      await json(path, { type: "restart_extensions" }).catch(() => {});
    }
  }
  let active;
  const rows = [], phases = [];
  const write = result => writeFile(join(output, "cold-warm-raw.json"), JSON.stringify({ host: "published-packaged-next-child", rows, phases, ...result }, null, 2));
  async function start(name) {
    await control({ action: "start", phase: name, sdkSpans: true });
    active = name;
  }
  async function stop() {
    phases.push(await control({ action: "stop", phase: active }));
    active = undefined;
  }
  try {
    await start("package-cold-warm");
    for (let i = 0; i < pairs; i++) {
      const [cold, warm] = await Promise.all(safe[i]);
      for (const entry of i % 2 ? [warm, cold] : [cold, warm]) rows.push(await sample(entry.id, entry.name, i));
      await write({});
    }
    await stop();
    await start("package-extension-ab");
    for (let i = 0; i < abPairs; i++) {
      const variants = await Promise.all(experiment[i]);
      for (const entry of variants.slice(i % 3).concat(variants.slice(0, i % 3))) {
        await control({ action: "variant", variant: entry.name });
        rows.push(await sample(entry.id, entry.name, i));
      }
      await write({});
    }
    await stop();
    await start("package-new-create");
    for (let i = 0; i < createSamples; i++) {
      const started = performance.now();
      const at = Date.now();
      const result = await json("/api/agent/new", { cwd, provider, modelId: model, type: "ensure_session" });
      assert.equal(result.success, true);
      rows.push({ id: result.sessionId, name: "new-create", createApiMs: performance.now() - started, createAt: at });
      await json("/api/agent/" + result.sessionId, { type: "restart_extensions" });
    }
    await stop();
    await write({ completed: true });
    return { rows, phases };
  } catch (error) {
    if (active) await stop().catch(() => {});
    await write({ error: error.stack });
    throw error;
  }
}
