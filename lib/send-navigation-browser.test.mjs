import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("submitted composer messages survive navigation during SSE setup and retain isolated recovery on rejection", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-send-navigation-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `
import React from "react";import {createRoot} from "react-dom/client";
import {useAgentSession} from "@/hooks/useAgentSession";import {I18nProvider} from "@/hooks/useI18n";
import {ChatInput} from "@/components/ChatInput";import {readPendingPrompts} from "@/lib/prompt-recovery";
import {readComposerRecord} from "@/lib/reply-storage";
window.readRecovery=readPendingPrompts;window.readDraft=id=>readComposerRecord('drafts',id);
window.sources=[];window.EventSource=class{static OPEN=1;static CLOSED=2;readyState=0;constructor(url){this.url=location.origin+url;window.sources.push(this)}close(){this.readyState=2}};
const sessions=Object.fromEntries(['a','b'].map(id=>[id,{id,cwd:'C:/fixture',name:id,modified:id}]));
function Chat({id,onCreated}){const state=useAgentSession({session:id==='new'?null:sessions[id],newSessionCwd:id==='new'?'C:/fixture':null,onSessionCreated:onCreated});window.state=state;
return <><section aria-label="history">{state.messages.map((m,i)=><p key={i}>{typeof m.content==='string'?m.content:''}{m.sendError&&<span role="alert">{m.sendError}</span>}</p>)}</section>
<ChatInput draftKey={id} cwd="C:/fixture" isStreaming={state.agentRunning} onSend={state.handleSend} onAbort={state.handleAbort}/></>}
function App(){const[id,setId]=React.useState('a');return <><nav>{['a','b','new'].map(key=><button key={key} onClick={()=>setId(key)}>{key}</button>)}</nav><output>{id}</output><Chat key={id} id={id} onCreated={()=>{window.promotions=(window.promotions||0)+1}}/></>}
localStorage.setItem('pi-locale','zh-CN');createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage(), errors = [], sends = [];
    page.on("pageerror", error => errors.push(error.message));
    let rejectSend = false, releaseCreation;
    await page.route("http://127.0.0.1:38213/**", async route => {
      const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
      if (request.method() === "POST" && pathname === "/api/agent/new") {
        await new Promise(resolve => { releaseCreation = resolve; });
        return route.fulfill({ json: { sessionId: "created" } });
      }
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname)) {
        const body = request.postDataJSON();
        if (body.type === "prompt" || body.type === "submit_input") {
          sends.push({ pathname, body });
          if (rejectSend) return route.fulfill({ status: 409, json: { error: "fixture rejected" } });
        }
        return route.fulfill({ json: { data: { sessionId: pathname.split('/').at(-1), commandId: "receipt" } } });
      }
      if (/^\/api\/sessions\/[^/]+$/.test(pathname)) return route.fulfill({ json: { context: { messages: [], entryIds: [] }, info: { id: pathname.split('/').at(-1), cwd: "C:/fixture" }, tree: [], persistedPromptIds: [] } });
      if (/^\/api\/agent\/[^/]+$/.test(pathname) || pathname.endsWith('/state')) return route.fulfill({ json: { running: false, state: { runtime: "idle" } } });
      if (pathname === "/api/models") return route.fulfill({ json: { models: {}, modelList: [], defaultModel: null } });
      return route.fulfill({ json: { available: false, items: [], commands: [], records: [], reviews: [], operations: [], templates: [], selectorVisible: false } });
    });
    await page.goto("http://127.0.0.1:38213/");
    await page.waitForFunction(() => window.state && !window.state.loading);
    const input = page.locator('textarea');
    await input.fill('message for A');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => window.sources.some(s => s.url.includes('/a/events') && s.readyState === 0));
    await page.getByRole('button', { name: 'b', exact: true }).click();
    await input.fill('B draft');
    await page.waitForFunction(async () => (await window.readDraft('b'))?.value === 'B draft');
    await assertEventually(() => sends.length === 1);
    assert.equal(sends[0].pathname, '/api/agent/a');
    assert.equal(sends[0].body.message, 'message for A');
    assert.equal(await input.inputValue(), 'B draft');
    assert.equal(await page.evaluate(() => window.sources.filter(s => s.url.includes('/a/events') && s.readyState !== 2).length), 0);
    assert.equal((await page.evaluate(() => window.readRecovery('a'))).length, 1, 'an HTTP acknowledgement alone never deletes recovery');

    // Explicit Stop remains cancellation; navigation alone is not cancellation.
    await page.getByRole('button', { name: 'a', exact: true }).click();
    await input.fill('cancel this message');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => window.state.agentRunning);
    await page.getByRole('button', { name: '停止智能体', exact: true }).click();
    await page.getByRole('button', { name: 'b', exact: true }).click();
    assert.equal(sends.length, 1);

    rejectSend = true;
    await page.getByRole('button', { name: 'a', exact: true }).click();
    await input.fill('rejected for A');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => window.sources.some(s => s.url.includes('/a/events') && s.readyState === 0));
    await page.getByRole('button', { name: 'b', exact: true }).click();
    await assertEventually(() => sends.length === 2);
    assert.equal(await input.inputValue(), 'B draft');
    await page.getByRole('button', { name: 'a', exact: true }).click();
    await page.getByRole('region', { name: 'history' }).getByText('rejected for A', { exact: false }).waitFor();
    assert.ok(await page.getByRole('alert').count(), 'returning to the original chat exposes a retryable recovery row');

    rejectSend = false;
    await page.getByRole('button', { name: 'new', exact: true }).click();
    await input.fill('new chat message');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await assertEventually(() => Boolean(releaseCreation));
    await page.getByRole('button', { name: 'b', exact: true }).click();
    releaseCreation();
    await assertEventually(() => sends.length === 3);
    assert.equal(sends[2].pathname, '/api/agent/created');
    assert.equal(await page.locator('output').textContent(), 'b');
    assert.equal(await page.evaluate(() => window.promotions || 0), 0, 'late creation must not steal navigation');
    assert.equal(await input.inputValue(), 'B draft');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('piora-send-navigation-'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertEventually(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'expected asynchronous operation to complete');
}
