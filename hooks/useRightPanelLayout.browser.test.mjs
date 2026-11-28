import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const root = path.resolve(import.meta.dirname, "..");

test("new draft sessions never inherit or restore an open browser panel", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-draft-browser-"));
  let browser;
  try {
    await writeFile(path.join(directory, "ts.cjs"), `
      const ts = require(${JSON.stringify(require.resolve("typescript"))});
      module.exports = source => ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
      }).outputText;
    `);
    await writeFile(path.join(directory, "entry.tsx"), `
      import { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { rightPanelLayoutScope, useRightPanelLayout } from "@/hooks/useRightPanelLayout";
      import { useBrowserPanelNavigation } from "@/hooks/useBrowserPanelNavigation";

      function Fixture() {
        const [sessionId, setSessionId] = useState<string | null>(null);
        const [sessionKey, setSessionKey] = useState(0);
        const layoutScope = rightPanelLayoutScope(sessionId, null);
        const conversationScope = "chat:" + (sessionId ?? ("new:" + sessionKey));
        const layout = useRightPanelLayout(layoutScope, rightPanelLayoutScope(null, null), sessionId, conversationScope);
        useBrowserPanelNavigation(conversationScope, layout.rightPanelTab, layout.setRightPanelOpen, layoutScope);
        (window as unknown as Record<string, unknown>).panelState = {
          sessionId,
          sessionKey,
          open: layout.rightPanelOpen,
          tab: layout.rightPanelTab,
          tools: layout.openRightPanelTools,
        };
        return <div>
          <button type="button" onClick={() => { layout.setRightPanelTab("browser"); layout.setRightPanelOpen(true); }}>Open browser</button>
          <button type="button" onClick={() => { layout.promoteDraftRightPanel("promoted-1"); setSessionId("promoted-1"); }}>Promote draft</button>
          <button type="button" onClick={() => { setSessionId(null); setSessionKey((k) => k + 1); }}>New session</button>
          <button type="button" onClick={() => { setSessionId("session-a"); setSessionKey((k) => k + 1); }}>Select A</button>
        </div>;
      }
      createRoot(document.getElementById("root")!).render(<Fixture />);
    `);
    const compiler = webpack({
      mode: "development",
      target: "web",
      devtool: false,
      entry: path.join(directory, "entry.tsx"),
      output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: {
        extensions: [".tsx", ".ts", ".js"],
        modules: [path.join(root, "node_modules"), "node_modules"],
        alias: { "@": root },
      },
      module: {
        rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "ts.cjs") }],
      },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => {
      if (error || stats.hasErrors()) reject(error ?? new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    })));

    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.addInitScript(() => {
      // Seed polluted storage with a stale open browser under "draft".
      localStorage.setItem("piora-right-panel-layouts-v1", JSON.stringify({
        draft: { open: true, maximized: false, activeTab: "browser", openTools: ["browser"] },
        "session:session-a": { open: true, maximized: false, activeTab: "browser", openTools: ["browser"] },
      }));
    });
    await page.route("http://draft-browser.test/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith(".js")) {
        return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      }
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
    });

    await page.goto("http://draft-browser.test/");
    await page.waitForFunction(() => Boolean(window.panelState));
    assert.equal(await page.evaluate(() => window.panelState.open), false, "polluted draft browser layout must not auto-open on load");

    // 1. Existing session with browser open -> clicking New session must NOT open browser.
    await page.getByRole("button", { name: "Select A" }).click();
    await page.waitForFunction(() => window.panelState.sessionId === "session-a" && window.panelState.open === true && window.panelState.tab === "browser");
    await page.getByRole("button", { name: "New session" }).click();
    await page.waitForFunction(() => window.panelState.sessionId === null && window.panelState.open === false);

    // 2. Open browser in draft, promote draft to a real session, then open another New session.
    await page.getByRole("button", { name: "Open browser" }).click();
    await page.waitForFunction(() => window.panelState.open === true && window.panelState.tab === "browser");
    await page.getByRole("button", { name: "Promote draft" }).click();
    await page.waitForFunction(() => window.panelState.sessionId === "promoted-1" && window.panelState.open === true && window.panelState.tab === "browser");
    await page.getByRole("button", { name: "New session" }).click();
    await page.waitForFunction(() => window.panelState.sessionId === null && window.panelState.open === false);
    assert.deepEqual(await page.evaluate(() => window.panelState.tools), [], "promoted draft must not leave browser tab behind for the next new session");

    // 3. Open browser in draft, then click New session again directly without promoting.
    await page.getByRole("button", { name: "Open browser" }).click();
    await page.waitForFunction(() => window.panelState.open === true && window.panelState.tab === "browser");
    await page.getByRole("button", { name: "New session" }).click();
    await page.waitForFunction(() => window.panelState.open === false);

    // 4. Verify draft key is never persisted to localStorage.
    const storedKeys = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("piora-right-panel-layouts-v1") ?? "{}")));
    assert.equal(storedKeys.includes("draft"), false, "draft layout must never be persisted in localStorage");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
