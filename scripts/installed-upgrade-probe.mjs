import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { waitUntil } from "./desktop-e2e/lifecycle.mjs";

const mode = process.argv[2];
const root = process.env.PIORA_INSTALL_UPGRADE_TEST_ROOT;
assert.ok(root, "Expected a dedicated test root");
const dot = join(root, "fixture.json");
const marker = "Piora retained chat from the old installation";
const inspectorPort = 28191;
const rendererPort = 28192;

async function prepare() {
  const agent = join(root, "agent"), project = join(root, "project"), profile = join(root, "profile");
  await Promise.all([agent, project, profile].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [] }));
  await writeFile(join(profile, "desktop-state.json"), JSON.stringify({ serverPort: 28193 }));
  process.env.PI_CODING_AGENT_DIR = agent;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const session = SessionManager.create(project);
  session.appendMessage({ role: "user", content: marker, timestamp: Date.now() });
  const file = session.getSessionFile();
  assert.ok(file);
  if (!existsSync(file)) await writeFile(file, [session.getHeader(), ...session.getEntries()].map(JSON.stringify).join("\n") + "\n", "utf8");
  await writeFile(dot, JSON.stringify({ id: session.getSessionId(), file }));
}

async function command(action) {
  const base = "http://127.0.0.1:" + inspectorPort;
  const targets = await (await fetch(base + "/json/list", { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(targets.length, 1, "Only the test instance should use its Inspector port");
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  const expression = action === "close-window"
    ? "setTimeout(() => electron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1:28193/')).close(), 100); true"
    : "setTimeout(() => electron.app.quit(), 100); true";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Owned app did not acknowledge shutdown command")); }, 6000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression: "(() => { const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); " + expression + "; return true; })()",
      returnByValue: true,
    } })), { once: true });
    socket.addEventListener("message", event => {
      const data = JSON.parse(event.data);
      if (data.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (data.error || data.result?.exceptionDetails) reject(new Error(JSON.stringify(data.error ?? data.result.exceptionDetails)));
      else resolve();
    });
  });
}

async function verify(label) {
  const evidence = JSON.parse(await readFile(dot, "utf8"));
  const base = "http://127.0.0.1:" + rendererPort;
  await waitUntil(async () => {
    try { return (await fetch(base + "/json/version", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  }, { timeoutMs: 90000, label: "the installed app's renderer" });
  const browser = await chromium.connectOverCDP(base, { timeout: 10000 });
  try {
    const page = await waitUntil(() => browser.contexts().flatMap(ctx => ctx.pages()).find(p => p.url().startsWith("http://127.0.0.1:28193/")),
      { timeoutMs: 90000, label: "authenticated installed application window" });
    await page.goto("http://127.0.0.1:28193/?session=" + encodeURIComponent(evidence.id), { waitUntil: "domcontentloaded", timeout: 60000 });
    const skip = page.getByRole("button", { name: /^(Skip guide|跳过引导)$/ });
    if (await skip.isVisible()) await skip.click();
    await page.locator("#chat-scroll-container").getByText(marker, { exact: true }).waitFor({ timeout: 60000 });
    await page.screenshot({ path: ".verification/nsis-upgrade/" + label + ".png", animations: "disabled" });
    console.log(JSON.stringify({ label, sessionId: evidence.id, messageVisible: true }));
  } finally {
    await browser.close();
  }
}

if (mode === "prepare") await prepare();
else if (mode === "close-window" || mode === "quit") await command(mode);
else if (mode === "before" || mode === "after") await verify(mode);
else throw new Error("Unknown installer verification mode");
