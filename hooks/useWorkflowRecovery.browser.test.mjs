import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("useWorkflow surfaces corrupt state over warm cache, accepts reset_corrupt revision 0, and blocks stale same-revision autoContinuing", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-workflow-recovery-"));
  let browser;
  try {
    await writeFile(
      path.join(directory, "ts.cjs"),
      `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`,
    );
    await writeFile(
      path.join(directory, "entry.tsx"),
      `
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/hooks/useI18n";
import { useWorkflow } from "@/hooks/useWorkflow";
import { clearWorkflowSnapshotCache } from "@/lib/workflow/client-cache";

declare global {
  interface Window {
    wf: ReturnType<typeof useWorkflow>;
    setLiveSnapshot: React.Dispatch<React.SetStateAction<any>>;
    setLiveCorrupt: React.Dispatch<React.SetStateAction<boolean>>;
    setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
    clearWfCache: typeof clearWorkflowSnapshotCache;
  }
}

function App() {
  const [sid, setSid] = React.useState<string | null>("s-corrupt");
  const [liveSnapshot, setLiveSnapshot] = React.useState<any>(null);
  const [liveCorrupt, setLiveCorrupt] = React.useState(false);
  const execute = React.useCallback(async (action: any) => {
    const res = await fetch("/api/agent/" + sid + "/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.snapshot;
  }, [sid]);

  const wf = useWorkflow(sid, true, false, execute, liveSnapshot, false, liveCorrupt);
  window.wf = wf;
  window.setLiveSnapshot = setLiveSnapshot;
  window.setLiveCorrupt = setLiveCorrupt;
  window.setSessionId = setSid;
  window.clearWfCache = clearWorkflowSnapshotCache;

  return (
    <div>
      <output id="rev">{wf.snapshot ? String(wf.snapshot.revision) : "none"}</output>
      <output id="auto">{String(Boolean(wf.snapshot?.autoContinuing))}</output>
      <output id="errCode">{wf.loadErrorCode ?? ""}</output>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<I18nProvider><App /></I18nProvider>);
`,
    );

    const compiler = webpack({
      mode: "development",
      target: "web",
      devtool: false,
      entry: path.join(directory, "entry.tsx"),
      output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "ts.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => (
      error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()
    ))));

    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ locale: "zh-CN" });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    let corrupt = false;
    let workflowGetCount = 0;
    let resetSnapshot = {
      sessionId: "s-corrupt",
      revision: 0,
      resetAt: 1_750_000_000_000,
      mode: "agent",
      turnBudget: 10,
      current: null,
      history: [],
    };
    const healthyRev7 = {
      sessionId: "s-corrupt",
      revision: 7,
      mode: "agent",
      turnBudget: 10,
      current: null,
      history: [],
    };

    await page.route("http://127.0.0.1:38219/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) {
        return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(url.pathname))) });
      }
      if (!url.pathname.startsWith("/api/")) {
        return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
      }
      if (url.pathname === "/api/agent/s-corrupt/workflow") {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          if (body.action === "reset_corrupt") {
            corrupt = false;
            return route.fulfill({ json: { snapshot: resetSnapshot } });
          }
        }
        workflowGetCount++;
        if (corrupt) {
          return route.fulfill({ status: 500, json: { error: "Invalid workflow state", code: "WORKFLOW_STATE_CORRUPT" } });
        }
        return route.fulfill({ json: healthyRev7 });
      }
      return route.fulfill({ status: 404, json: {} });
    });

    await page.goto("http://127.0.0.1:38219/");
    await page.waitForFunction(() => document.getElementById("rev")?.textContent === "7");

    // 1. Switch away, mark file corrupt on server, switch back with inline liveCorrupt=true.
    // Warm cache has idle rev 7, yet liveCorrupt must invalidate cache and fetch /workflow immediately.
    corrupt = true;
    const getsBeforeCorrupt = workflowGetCount;
    await page.evaluate(() => {
      window.setSessionId("other");
    });
    await page.evaluate(() => {
      window.setLiveCorrupt(true);
      window.setSessionId("s-corrupt");
    });
    await page.waitForFunction(() => document.getElementById("errCode")?.textContent === "WORKFLOW_STATE_CORRUPT");
    assert.ok(workflowGetCount > getsBeforeCorrupt, "corrupt state must trigger a dedicated /workflow read despite warm cache");
    assert.equal(await page.locator("#rev").textContent(), "none");

    // 2. Reset corrupt state returning revision 0 with resetAt must supersede cached rev 7 and clear the error.
    await page.evaluate(() => {
      window.setLiveCorrupt(false);
    });
    const resetOk = await page.evaluate(() => window.wf.resetCorrupt());
    assert.equal(resetOk, true);
    await page.waitForFunction(() => document.getElementById("rev")?.textContent === "0");
    assert.equal(await page.locator("#errCode").textContent(), "");

    // 3. Stale pre-reset revision 7 arriving late must be rejected.
    await page.evaluate((stale) => {
      window.setLiveSnapshot(stale);
    }, healthyRev7);
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#rev").textContent(), "0", "pre-reset rev 7 must not overwrite post-reset rev 0");

    // 4. Same-revision transientSeq: SSE clearing autoContinuing (transientSeq: 1)
    // must not be overwritten by a late HTTP /state snapshot (autoContinuing: true, transientSeq: undefined).
    const newerSse = {
      sessionId: "s-corrupt",
      revision: 5,
      resetAt: 1_750_000_000_000,
      transientSeq: 1,
      mode: "goal",
      turnBudget: 10,
      current: null,
      history: [],
    };
    const staleHttp = {
      sessionId: "s-corrupt",
      revision: 5,
      resetAt: 1_750_000_000_000,
      autoContinuing: true,
      mode: "goal",
      turnBudget: 10,
      current: null,
      history: [],
    };
    await page.evaluate((snap) => window.setLiveSnapshot(snap), newerSse);
    await page.waitForFunction(() => document.getElementById("rev")?.textContent === "5");
    assert.equal(await page.locator("#auto").textContent(), "false");

    await page.evaluate((snap) => window.setLiveSnapshot(snap), staleHttp);
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#auto").textContent(), "false", "stale same-revision autoContinuing HTTP response must be ignored");

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
