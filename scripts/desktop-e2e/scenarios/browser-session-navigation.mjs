import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openChatBrowser } from "../open-chat-browser.mjs";
import { browserSettings } from "./browser-settings.mjs";

let fixture;
export const browserSessionNavigation = {
  id: "browser-session-navigation",
  scope: "Real Windows Electron chat navigation, native browser views and browser settings using synthetic chats and a loopback page.",
  coverage: ["existing-chat and new-chat entry points do not reveal a blank browser", "returning to A restores its page", "manual browser opening remains usable", ...browserSettings.coverage],
  limits: ["real accounts", "external websites", "published installer", ...browserSettings.limits],
  async prepare({ paths, directory, registerCleanup, report }) {
    const project = join(directory, "project"), sessions = join(paths.agent, "sessions", "--browser-navigation-fixture--");
    await mkdir(project); await mkdir(sessions, { recursive: true });
    fixture = {};
    for (const name of ["A", "B"]) {
      const id = randomUUID(), timestamp = new Date().toISOString(); fixture[name] = id;
      await writeFile(join(sessions, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`), [
        { type: "session", version: 3, id, cwd: project, timestamp },
        { type: "message", id: "10000001", parentId: null, timestamp, message: { role: "user", content: `Browser navigation fixture ${name}`, timestamp: Date.now() } },
        { type: "session_info", id: "10000002", parentId: "10000001", timestamp, name: `Browser Navigation ${name}` },
      ].map(JSON.stringify).join("\n") + "\n");
    }
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Local navigation fixture</title><h1>Browser still works</h1>");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    registerCleanup(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    fixture.url = `http://127.0.0.1:${server.address().port}/navigation-fixture`;
    report.fixture = { A: fixture.A, B: fixture.B, source: "synthetic chats and loopback site; no accounts or model calls" };
  },
  async run(context) {
    const { page, getBrowser, directory, step, waitUntil } = context;
    const evidence = [];
    const state = () => page.evaluate(() => window.piDesktop.browser.getState());
    const chat = id => page.locator(`[data-chat-surface][data-session-id="${id}"]`);
    const address = page.getByRole("combobox", { name: /^(Address|地址)$/ });
    const home = page.locator("[data-browser-home]");
    const shot = name => page.screenshot({ path: join(directory, name), animations: "disabled", timeout: 30000 });
    const select = async id => {
      const row = page.locator(`[data-session-drag-id="${id}"]`);
      const show = page.getByRole("button", { name: /^(Show sidebar|显示侧边栏)$/ }).first();
      if (!await row.isVisible() && await show.isVisible()) await show.click();
      await row.click(); await chat(id).waitFor();
    };
    let original;
    const noAutomaticBrowser = async name => {
      await page.waitForTimeout(1200);
      assert.equal(await address.isVisible(), false, `${name} must not reveal the browser`);
      assert.equal(await home.isVisible(), false, `${name} must not reveal a blank home`);
      const current = await state();
      assert.equal(current.tabCount, original.tabCount, `${name} must not allocate a tab`);
      evidence.push({ name, tabCount: current.tabCount, browserVisible: false });
    };
    try {
      await step("open-local-page-in-a", async () => {
        // Desktop reserves a manual-browser tab at startup. Count changes from
        // that baseline, independently of tabs owned by these synthetic chats.
        const initialTabCount = (await state()).tabCount;
        await openChatBrowser(page, fixture.A, waitUntil);
        assert.equal((await state()).tabs.length, 0);
        await address.fill(fixture.url); await address.press("Enter");
        const target = await waitUntil(() => getBrowser().contexts().flatMap(c => c.pages()).find(p => p.url() === fixture.url), "local native browser target");
        await target.getByRole("heading", { name: "Browser still works" }).waitFor();
        await home.waitFor({ state: "hidden" });
        original = await state();
        assert.equal(original.tabs.length, 1);
        assert.equal(original.tabCount, initialTabCount + 1);
        evidence.push({ name: "A explicit navigation", initialTabCount, tabCount: original.tabCount });
      });
      await step("switch-to-existing-b-without-blank-browser", async () => {
        await select(fixture.B); await noAutomaticBrowser("existing B");
        await shot("existing-b-no-browser.png");
      });
      await step("new-chat-without-blank-browser", async () => {
        await page.getByRole("button", { name: /^(New chat|新对话)$/ }).first().click();
        await chat(fixture.B).waitFor({ state: "hidden" });
        await page.locator("textarea:visible").first().waitFor();
        await noAutomaticBrowser("new chat");
        await shot("new-chat-no-browser.png");
      });
      await step("return-to-a-and-manually-open-b", async () => {
        await openChatBrowser(page, fixture.A, waitUntil);
        await waitUntil(async () => (await state()).activeTabId === original.activeTabId, "A original tab restored");
        assert.equal((await state()).url, fixture.url);
        await shot("a-browser-restored.png");
        await openChatBrowser(page, fixture.B, waitUntil);
        await home.waitFor(); assert.equal((await state()).tabs.length, 0);
        await address.fill(`${fixture.url}?manual=b`); await address.press("Enter");
        await waitUntil(async () => (await state()).url === `${fixture.url}?manual=b`, "manual B navigation");
        await home.waitFor({ state: "hidden" });
        assert.equal((await state()).tabs.length, 1);
        assert.equal((await state()).tabCount, original.tabCount + 1);
        await shot("b-browser-manually-opened.png");
      });
      await browserSettings.run(context);
    } finally {
      await writeFile(join(directory, "browser-navigation-evidence.json"), JSON.stringify(evidence, null, 2));
    }
  },
};
