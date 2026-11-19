import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const heading = "Existing long assistant reply";
const middle = "The middle of the original reply";
const tail = "The final line of the original reply";
const sections = Array.from({ length: 320 }, (_, index) => "Paragraph " + (index + 1) + ". " + "Existing conversation text. ".repeat(48));
const longReply = ["# " + heading, ...sections.slice(0, 160), "## " + middle, ...sections.slice(160), tail].join("\n\n");
const digest = value => createHash("sha256").update(value).digest("hex");
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
  const legacy = SessionManager.create(project);
  legacy.appendMessage({ role: "user", content: "My previously opened long conversation", timestamp: Date.now() });
  const replyId = legacy.appendMessage({ role: "assistant", content: [{ type: "text", text: longReply }], api: "openai-completions",
    provider: "fixture", model: "offline", stopReason: "stop", timestamp: Date.now() });
  const legacyFile = legacy.getSessionFile();
  assert.ok(legacyFile && replyId && Buffer.byteLength(longReply) > 256 * 1024);
  if (!existsSync(legacyFile)) await writeFile(legacyFile, [legacy.getHeader(), ...legacy.getEntries()].map(JSON.stringify).join("\n") + "\n", "utf8");
  await writeFile(dot, JSON.stringify({ id: session.getSessionId(), file, legacyId: legacy.getSessionId(), legacyFile, replyId, replyHash: digest(longReply) }));
}

async function verifyLegacyReply(page, label, evidence) {
  await page.goto("http://127.0.0.1:28193/?session=" + encodeURIComponent(evidence.legacyId), { waitUntil: "domcontentloaded", timeout: 60000 });
  const transcript = page.locator("#chat-scroll-container");
  const originalButton = transcript.getByRole("button", { name: /^(在完整历史中查看原文|Open original in history)$/ });
  const entry = (await readFile(evidence.legacyFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.id === evidence.replyId);
  assert.equal(digest(entry.message.content[0].text), evidence.replyHash);
  let originalButtonCount;
  if (label === "before") {
    await originalButton.waitFor({ timeout: 90000 });
    await originalButton.scrollIntoViewIfNeeded();
    originalButtonCount = await originalButton.count();
    assert.equal(originalButtonCount, 1);
    assert.equal(await transcript.getByText(tail, { exact: true }).count(), 0);
  } else {
    const reply = transcript.locator('[data-chat-entry-id="' + evidence.replyId + '"]');
    await reply.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 90000 });
    await reply.getByRole("heading", { name: middle, exact: true }).waitFor({ timeout: 90000 });
    const end = reply.getByText(tail, { exact: true });
    await end.waitFor({ timeout: 90000 });
    await end.scrollIntoViewIfNeeded();
    originalButtonCount = await originalButton.count();
    assert.equal(originalButtonCount, 0);
    const paragraphs = await reply.locator("p").allTextContents();
    assert.deepEqual(paragraphs.map(p => p.trim()), [...sections.map(p => p.trim()), tail]);
    const chatText = await page.evaluate(async id => {
      const response = await fetch("/api/sessions/" + encodeURIComponent(id) + "?view=chat&deferMedia=1&deferThinking=1");
      if (!response.ok) throw new Error("Could not reload chat history: " + response.status);
      const { context } = await response.json();
      return context.messages.find(message => message.role === "assistant")?.content[0]?.text;
    }, evidence.legacyId);
    assert.equal(digest(chatText), evidence.replyHash);
  }
  const record = { versionStage: label, sessionId: evidence.legacyId, replyId: evidence.replyId, originalButtonCount,
    originalBytes: Buffer.byteLength(longReply), originalSha256: evidence.replyHash, renderedBodyParagraphs: label === "after" ? sections.length + 1 : undefined };
  const artifact = ".verification/nsis-upgrade/" + label + "-legacy-long-reply";
  await page.screenshot({ path: artifact + ".png", animations: "disabled" });
  await writeFile(artifact + ".json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
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
    await verifyLegacyReply(page, label, evidence);
  } finally {
    await browser.close();
  }
}

if (mode === "prepare") await prepare();
else if (mode === "close-window" || mode === "quit") await command(mode);
else if (mode === "before" || mode === "after") await verify(mode);
else throw new Error("Unknown installer verification mode");
