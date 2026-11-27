import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";

test("repeated real SDK model-selection failures retain no service bundles and a valid session still starts", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-startup-cleanup-"));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR, previousProfile = process.env.PIORA_RUNTIME_PROFILE;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PIORA_RUNTIME_PROFILE = "normal";
  const cwd = join(root, "workspace"); await mkdir(cwd);
  let session;
  try {
    const jiti = createJiti(import.meta.url);
    const { startRpcSession } = await jiti.import("./rpc-manager.ts");
    const { scheduleSessionModels } = await jiti.import("./session-model-selection.ts");
    const legacySession = async (id) => {
      const file = join(root, `${id}.jsonl`);
      const timestamp = new Date().toISOString();
      const entries = [
        { type: "session", version: 3, id, cwd, timestamp },
        { type: "custom", id: "a0000001", parentId: null, timestamp, customType: "piora-remote-policy", data: { policy: "notes" } },
      ];
      await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      return file;
    };
    const baseline = globalThis.__piServicesCache?.size ?? 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = `failed-start-${attempt}`;
      scheduleSessionModels([id], { provider: "piora-test-unavailable", modelId: "missing" });
      await assert.rejects(async () => {
        session = (await startRpcSession(id, await legacySession(id), cwd, { allowModelFallback: false })).session;
      }, /not available|not found/i);
      assert.equal(globalThis.__piServicesCache.size, baseline);
      assert.equal(globalThis.__piStartLocks.size, 0);
      assert.equal(globalThis.__piStartingSessionCwds.size, 0);
    }
    session = (await startRpcSession("valid-start", await legacySession("valid-start"), cwd)).session;
    assert.equal(session.isAlive(), true); assert.deepEqual(session.inner.getActiveToolNames(), []);
    assert.equal(session.nativeMcp, undefined);
    assert.equal(session.inner.getAllTools().some(tool => ["codemode", "tool_search"].includes(tool.name) || tool.name.startsWith("mcp__")), false);
    assert.equal(globalThis.__piServicesCache.size, baseline + 1);
    session.destroy(); await session.shutdownForFileMutation();
    assert.equal(globalThis.__piServicesCache.size, baseline);
  } finally {
    session?.destroy(); await session?.shutdownForFileMutation();
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    if (previousProfile === undefined) delete process.env.PIORA_RUNTIME_PROFILE; else process.env.PIORA_RUNTIME_PROFILE = previousProfile;
    assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
