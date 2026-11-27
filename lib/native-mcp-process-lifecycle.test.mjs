import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(".") } });
const { ManagedMcpStdioTransport, registerIdleMcpSessionEvictor } = await jiti.import("./native-mcp/stdio-lifecycle.ts");

const leasesKey = Symbol.for("piora.native-mcp.stdio-leases");
const windowsJobKey = Symbol.for("piora.native-mcp.windows-job");
const evictIdleKey = Symbol.for("piora.native-mcp.evict-idle-session");

test("ManagedMcpStdioTransport evicts idle sessions before rejecting at the connection cap", async (t) => {
  const previousLimit = process.env.PIORA_MAX_MCP_STDIO_CONNECTIONS;
  const previousEvictor = globalThis[evictIdleKey];
  const previousJobFactory = globalThis[windowsJobKey];
  process.env.PIORA_MAX_MCP_STDIO_CONNECTIONS = "1";
  globalThis[windowsJobKey] = undefined;

  const first = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [resolve("lib/native-mcp-fixture.mjs")],
  });
  const second = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [resolve("lib/native-mcp-fixture.mjs")],
  });
  const third = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [resolve("lib/native-mcp-fixture.mjs")],
  });

  t.after(async () => {
    await Promise.allSettled([first.close(), second.close(), third.close()]);
    if (previousLimit === undefined) delete process.env.PIORA_MAX_MCP_STDIO_CONNECTIONS;
    else process.env.PIORA_MAX_MCP_STDIO_CONNECTIONS = previousLimit;
    globalThis[evictIdleKey] = previousEvictor;
    globalThis[windowsJobKey] = previousJobFactory;
  });

  await first.start();
  assert.equal(globalThis[leasesKey].size, 1);

  let evictions = 0;
  registerIdleMcpSessionEvictor(async () => {
    if (evictions === 0) {
      evictions += 1;
      await first.close();
      return true;
    }
    return false;
  });

  await second.start();
  assert.equal(evictions, 1, "should evict idle MCP session to free a lease");
  assert.equal(globalThis[leasesKey].size, 1);

  await assert.rejects(
    () => third.start(),
    /reached its 1 native MCP stdio connections/,
  );
  assert.equal(globalThis[leasesKey].size, 1);
});

test("ManagedMcpStdioTransport surfaces spawn errors without masking from job.attach failure", async (t) => {
  const previousJobFactory = globalThis[windowsJobKey];
  let attachCalls = 0;
  let closed = 0;
  globalThis[windowsJobKey] = () => ({
    attach() {
      attachCalls += 1;
      throw new Error("simulated attach race");
    },
    close() {
      closed += 1;
    },
  });
  t.after(() => {
    globalThis[windowsJobKey] = previousJobFactory;
  });

  // Even if Windows job attachment fails (e.g. short-lived child exits before attach),
  // ManagedMcpStdioTransport must not throw the attach error and must still clean up the job on close.
  const server = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [resolve("lib/native-mcp-fixture.mjs")],
  });
  await server.start();
  assert.equal(attachCalls, 1, "should have attempted Windows job attach");
  await server.close();
  assert.ok(closed >= 1, "job handle should be closed on transport close");
});
