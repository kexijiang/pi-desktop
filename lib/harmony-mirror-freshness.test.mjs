import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HarmonyMediaStreamController } = await jiti.import("./harmony/manager/media-stream-controller.ts");
const { HarmonyManualPointerController } = await jiti.import("./harmony/manager/manual-pointer-controller.ts");
const { MIRROR_PROFILE } = await jiti.import("./harmony/mirror/profile.ts");

const packet = (type, payload) => {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(type, 0);
  result.writeUInt32BE(payload.length, 4);
  payload.copy(result, 8);
  return result;
};

const configPacket = (width = 720, height = 1600) => {
  const payload = Buffer.alloc(13);
  payload.writeUInt32BE(width, 1);
  payload.writeUInt32BE(height, 5);
  return packet(2, payload);
};

function createHarness() {
  let now = Date.now();
  let generation = 1;
  let streamController;
  const calls = [];
  const lease = { token: "lease-1", serial: "phone-1", deviceEpoch: generation, owner: { kind: "manual", id: "manual:test" }, expiresAt: new Date(now + 60_000).toISOString() };
  let requestKeyframeImpl = () => {};
  const backend = {
    displayGeometry: async () => ({ nativeWidth: 1440, nativeHeight: 3200, displayId: "0", displayRotation: 0 }),
    pointerPhase: async (serial, phase, id, x, y) => { calls.push({ serial, phase, id, x, y }); },
    openVideoStream: async () => ({
      stream: new ReadableStream({ start(controller) { streamController = controller; } }),
      requestKeyframe: () => requestKeyframeImpl(),
      async close() { try { streamController.close(); } catch { /* Already closed. */ } },
    }),
  };
  const media = new HarmonyMediaStreamController({
    cleanupTimeoutMs: 1000,
    now: () => now,
    isDisposed: () => false,
    getDevice: serial => serial === "phone-1" ? { serial, state: "online", generation } : undefined,
    getGeneration: serial => serial === "phone-1" ? generation : undefined,
    requireBackend: () => backend,
    requireAdmission: () => undefined,
    onlineDevice: async serial => ({ serial, state: "online", generation }),
    enqueue: async (_op, task) => task(new AbortController().signal, 1),
  });
  const pointer = new HarmonyManualPointerController({
    now: () => now,
    getGeneration: serial => serial === "phone-1" ? generation : undefined,
    requireLease: (serial, token) => {
      if (serial !== lease.serial || token !== lease.token) throw new Error("invalid lease");
      return lease;
    },
    requireBackend: () => backend,
    getGeometry: key => media.getGeometry(key),
    getFrameCapturedAt: key => media.getFrameCapturedAt(key),
    getFrameGeometry: (serial, space, signal) => media.getFrameGeometry(serial, space, signal),
    resolveInputPoint: (options, x, y, signal) => media.resolveInputPoint(options, x, y, signal),
    action: async (_op, _serial, _token, _gen, signal, invoke) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await invoke(backend, controller.signal);
        return { receipt: { dispatchState: "sent" } };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
  return {
    media,
    pointer,
    backend,
    calls,
    lease,
    setRequestKeyframe(fn) { requestKeyframeImpl = fn; },
    advance(ms) { now += ms; },
    enqueue(bytes) { streamController.enqueue(bytes); },
    setGeneration(next) { generation = next; },
  };
}

test("idle mirror profile keeps quiet screens below the 1000 ms live-pointer freshness ceiling", () => {
  assert.ok(MIRROR_PROFILE.idleKeyframeCheckIntervalMs > 0 && MIRROR_PROFILE.idleKeyframeCheckIntervalMs < MIRROR_PROFILE.idleKeyframeIntervalMs);
  assert.ok(MIRROR_PROFILE.idleKeyframeIntervalMs + MIRROR_PROFILE.idleKeyframeCheckIntervalMs < 1000);
});

test("quiet stream refreshes via on-demand keyframe before live pointer down and stays valid after displayGeometry delay", async t => {
  const h = createHarness();
  const conn = await h.media.openVideoStream({ serial: "phone-1" });
  const reader = conn.stream.getReader();
  t.after(async () => { await reader.cancel().catch(() => undefined); await conn.close().catch(() => undefined); });

  h.enqueue(Buffer.concat([configPacket(720, 1600), packet(3, Buffer.from([1, 0]))]));
  await reader.read();
  const geometry = await h.media.getFrameGeometry("phone-1", "video");

  // Simulate a static screen whose last frame is 2.5s old and slow hidumper geometry probe (350ms).
  h.advance(2500);
  const originalGeometry = h.backend.displayGeometry;
  h.backend.displayGeometry = async (...args) => {
    h.advance(350);
    return originalGeometry(...args);
  };
  let keyframeRequests = 0;
  h.setRequestKeyframe(() => {
    keyframeRequests++;
    setTimeout(() => {
      h.enqueue(packet(3, Buffer.from([1, keyframeRequests])));
      void reader.read();
    }, 15);
  });

  const { gestureId } = await h.pointer.begin({
    serial: "phone-1",
    leaseToken: h.lease.token,
    generation: 1,
    coordinateSpace: "frame",
    geometryId: geometry.geometryId,
    x: 360,
    y: 800,
  });
  assert.ok(keyframeRequests >= 1, "stale quiet frame triggers keyframe recovery before pointer validation");
  await h.pointer.update({ serial: "phone-1", leaseToken: h.lease.token, gestureId, phase: "up" });
  assert.deepEqual(h.calls.map(({ phase, x, y }) => ({ phase, x, y })), [
    { phase: "down", x: 720, y: 1600 },
    { phase: "up", x: 720, y: 1600 },
  ]);
});

test("truly stalled video stream still rejects geometry and pointer dispatch without sending touch", async t => {
  const h = createHarness();
  const conn = await h.media.openVideoStream({ serial: "phone-1" });
  const reader = conn.stream.getReader();
  t.after(async () => { await reader.cancel().catch(() => undefined); await conn.close().catch(() => undefined); });

  h.enqueue(Buffer.concat([configPacket(720, 1600), packet(3, Buffer.from([1, 0]))]));
  await reader.read();
  const geometry = await h.media.getFrameGeometry("phone-1", "video");

  h.advance(2500);
  let keyframeRequests = 0;
  h.setRequestKeyframe(() => { keyframeRequests++; });

  await assert.rejects(
    h.pointer.begin({
      serial: "phone-1",
      leaseToken: h.lease.token,
      generation: 1,
      coordinateSpace: "frame",
      geometryId: geometry.geometryId,
      x: 360,
      y: 800,
    }),
    error => error.code === "STALE_SNAPSHOT" && error.details?.dispatchState === "not-sent",
  );
  assert.ok(keyframeRequests >= 1);
  assert.equal(h.calls.length, 0);
});

test("repeated same-size SPS/PPS retains geometry and freshness while actual resize invalidates both", async t => {
  const h = createHarness();
  const conn = await h.media.openVideoStream({ serial: "phone-1" });
  const reader = conn.stream.getReader();
  t.after(async () => { await reader.cancel().catch(() => undefined); await conn.close().catch(() => undefined); });

  h.enqueue(Buffer.concat([configPacket(720, 1600), packet(3, Buffer.from([1, 0]))]));
  await reader.read();
  const initial = await h.media.getFrameGeometry("phone-1", "video");

  h.enqueue(configPacket(720, 1600));
  await reader.read();
  assert.equal(h.media.getGeometry("phone-1:video")?.geometryId, initial.geometryId);
  assert.ok(h.media.getFrameCapturedAt("phone-1:video"));

  h.enqueue(configPacket(1600, 720));
  await reader.read();
  assert.equal(h.media.getGeometry("phone-1:video"), undefined);
  assert.equal(h.media.getFrameCapturedAt("phone-1:video"), undefined);
});
