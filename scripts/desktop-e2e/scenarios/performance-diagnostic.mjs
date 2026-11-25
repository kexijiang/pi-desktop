import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const provider = 'performance-fixture';
const model = 'controlled-stream';
const approvalScope = 'local loopback only';
const fixtureFirstDelayMs = 45;
const fixtureChunkIntervalMs = 90;
const fixtureHistoryTurns = 45;
const fixtureState = new Map();
const stopName = /^(Stop agent|停止智能体)$/;
const sendName = /^(Send|发送)$/;
const toolNames = {
  browser: /^(Browser|浏览器)$/, files: /^(Files|文件)$/, commands: /^(Terminal|终端)$/,
};
const histories = [
  'Compile', 'Lane 1', 'Lane 2', 'Lane 3', 'Lane 4',
  'Cold A', 'Warm A', 'Cold B', 'Warm B', 'Cold C', 'Warm C',
];
const usage = {
  input: 150, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 195,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function readProductFixtureToken(page) {
  const cdp = await page.context().newCDPSession(page);
  const pathname = '/api/health?performance-fixture-auth=1';
  const matches = new Set();
  const tokenByRequest = new Map();
  let secret;
  cdp.on('Network.requestWillBeSent', event => {
    if (!event.request.url.endsWith(pathname)) return;
    matches.add(event.requestId);
    secret ||= tokenByRequest.get(event.requestId);
  });
  cdp.on('Network.requestWillBeSentExtraInfo', event => {
    const header = Object.entries(event.headers)
      .find(([name]) => name.toLowerCase() === 'x-pi-desktop-token')?.[1];
    if (typeof header !== 'string') return;
    tokenByRequest.set(event.requestId, header);
    if (matches.has(event.requestId)) secret = header;
  });
  try {
    await cdp.send('Network.enable');
    await page.evaluate(async path => {
      const result = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
      if (!result.ok) throw new Error('Desktop authentication probe HTTP ' + result.status);
      await result.arrayBuffer();
    }, pathname);
    return secret;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function prepare({ paths, directory, env, registerCleanup, report }) {
  const cwd = join(directory, 'workspace');
  const folder = join(paths.agent, 'sessions', '--performance-fixture--');
  const serverDirectory = join(directory, 'server');
  const terminalCounter = join(directory, 'terminal-counter.txt');
  await Promise.all([mkdir(cwd), mkdir(folder, { recursive: true }), mkdir(serverDirectory)]);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', cwd], { windowsHide: true, stdio: 'pipe' });
  const inputFiles = ['perf-sample-a.txt', 'perf-sample-b.txt'];
  await Promise.all(inputFiles.map((name, index) => writeFile(join(cwd, name),
    Array.from({ length: 160 }, (_, line) => 'Fixture ' + index + ', file line ' + (line + 1) + '\n').join(''))));

  const sessions = {};
  for (let sessionIndex = 0; sessionIndex < histories.length; sessionIndex++) {
    const id = randomUUID();
    const name = histories[sessionIndex];
    const timestamp = new Date(Date.now() - sessionIndex * 100000).toISOString();
    const rows = [{ type: 'session', version: 3, id, cwd, timestamp }];
    for (let index = 1; index <= fixtureHistoryTurns * 2; index++) {
      const entryId = index.toString(16).padStart(8, '0');
      const parentId = index === 1 ? null : (index - 1).toString(16).padStart(8, '0');
      const turn = Math.ceil(index / 2);
      const message = index % 2
        ? { role: 'user', content: 'Fixture question ' + turn, timestamp: Date.parse(timestamp) + index }
        : {
          role: 'assistant', provider, model, api: 'openai-completions', stopReason: 'stop',
          content: [{ type: 'text', text: '### Archived fixture reply ' + turn + '\n\n'
            + 'Text for the chat scroll baseline and workload comparison. '.repeat(6)
            + '\n\n- First item\n- Second item' }],
          usage, timestamp: Date.parse(timestamp) + index,
        };
      rows.push({ type: 'message', id: entryId, parentId, timestamp, message });
    }
    rows.push({ type: 'session_info', id: '00000100',
      parentId: (fixtureHistoryTurns * 2).toString(16).padStart(8, '0'), name: 'Perf ' + name, timestamp });
    await writeFile(join(folder, id + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    sessions[name] = id;
  }

  const calls = [];
  const streams = new Map();
  const webRequests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      webRequests.push({ url: request.url, at: Date.now() });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Piora performance fixture</title><h1>Local browser fixture</h1>'
        + '<p id="update">Browser ready</p><script>let frame=0;setInterval(()=>{document.getElementById("update").textContent="Browser ready "+(++frame)},1000)</script>');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const lastUser = body.messages?.findLast(entry => entry.role === 'user');
    const marker = /PERF_REQUEST_([A-Z0-9]+)/.exec(JSON.stringify(lastUser))?.[1] ?? 'UNKNOWN';
    const held = marker.startsWith('HOLD');
    const row = { marker, at: Date.now(), firstAt: null, lastChunkAt: null, chunks: 0, closedAt: null, held,
      messages: body.messages?.length, normalizedContextBytes: Buffer.byteLength(JSON.stringify(body.messages?.slice(0, -1) ?? [])) };
    calls.push(row);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const emit = (delta, finish_reason = null) => {
      if (response.destroyed || response.writableEnded) return;
      response.write('data: ' + JSON.stringify({
        id: marker, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model, choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      row.chunks++;
      row.lastChunkAt = Date.now();
      if (row.firstAt === null) row.firstAt = row.lastChunkAt;
    };
    const finish = () => {
      if (!response.destroyed && !response.writableEnded) {
        emit({ content: '\n\nPERF_FINISH_' + marker });
        emit({}, 'stop');
        response.end('data: [DONE]\n\n');
      }
    };
    let tick;
    const first = setTimeout(() => {
      emit({ role: 'assistant', content: 'PERF_FIRST_' + marker });
      if (!held) return void setTimeout(finish, 80).unref();
      tick = setInterval(() => {
        if (row.chunks >= 4500) return finish();
        emit({ content: row.chunks % 10 === 0 ? '\n\n- Fixture stream continues.' : ' output' });
      }, fixtureChunkIntervalMs);
    }, fixtureFirstDelayMs);
    streams.set(marker, { finish, row });
    response.once('close', () => {
      clearTimeout(first);
      clearInterval(tick);
      row.closedAt = Date.now();
      streams.delete(marker);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerCleanup(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));

  const fixtureOrigin = 'http://127.0.0.1:' + server.address().port;
  await writeFile(join(paths.agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
    api: 'openai-completions', baseUrl: fixtureOrigin + '/v1', apiKey: 'local-test-only',
    models: [{ id: model, name: 'Performance Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  const settingsFile = join(paths.agent, 'settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(settingsFile, JSON.stringify({ ...settings, enabledModels: [provider + '/' + model] }));
  const token = randomBytes(32).toString('base64url');
  env.PIORA_PERF_DESKTOP_TOKEN = token;
  if (report.application === 'development' || process.env.PIORA_PERF_PACKAGED_CONTROL) {
    env.PIORA_PERF_SERVER_DIR = serverDirectory;
  }
  env.PIORA_PERF_ELECTRON_NETLOG = join(directory, 'netlog.raw.json');
  env.PIORA_DESKTOP_E2E_FIXED_SOURCE = '1';
  if (process.env.PIORA_PERF_PACKAGED_CONTROL && process.env.PIORA_PERF_SMOKE !== '1') env.PIORA_PERF_PACKAGE_SDK_SPANS = '1';
  if (process.env.PIORA_PERF_PACKAGED_ATTACH_LATE === '1') env.PIORA_PERF_PACKAGE_ATTACH_LATE = '1';
  fixtureState.set(directory, { cwd, terminalCounter, sessions, streams, calls, inputFiles, token, fixtureOrigin, webRequests });
  report.fixture = { model: provider + '/' + model, auth: approvalScope, cwd, sessions, fixtureOrigin,
    firstDelayMs: fixtureFirstDelayMs, chunkIntervalMs: fixtureChunkIntervalMs, historyTurns: fixtureHistoryTurns,
    userProfile: 'independent fixture profile, no production credentials', serverDirectory };
}

async function run({ page, origin, getBrowser, directory, step, waitUntil, reload, screenshot, signal, packaged, paths }) {
  const fixture = fixtureState.get(directory);
  assert.ok(fixture);
  fixtureState.delete(directory);
  const probe = process.env.PIORA_PERF_STARTUP_ONLY === '1';
  if (probe) return;
  const smoke = process.env.PIORA_PERF_SMOKE === '1';
  const packagedControlPath = process.env.PIORA_PERF_PACKAGED_CONTROL;
  const packagedControl = packaged && packagedControlPath
    ? (await import(pathToFileURL(packagedControlPath).href)).controlPackagedServer
    : undefined;
  const packagedSample = body => packagedControl(join(directory, 'server'), body);
  const { attachPerfNetwork } = await import('../perf-network.mjs');
  const { attachPerfRenderer } = await import('../perf-renderer.mjs');
  const network = await attachPerfNetwork(page);
  const renderer = await attachPerfRenderer(page);
  const diagnostics = { phases: [], firstResponses: [], actions: [], stability: [], coldHot: [], fixture: [] };
  const phaseErrors = [];
  let activePhase = 'setup';
  let currentSession;
  let modelSerial = 0;
  const heldLaneMarkers = new Map();
  const token = packaged ? await readProductFixtureToken(page).catch(() => undefined) : fixture.token;
  const tokenHeaders = token ? { 'X-Pi-Desktop-Token': token } : {};
  diagnostics.authentication = token ? 'authenticated loopback reads outside renderer network pool' : 'isolated Electron renderer read-only authentication fallback';
  diagnostics.serverSampling = packaged
    ? packagedControl ? 'Packaged runtime sampled by isolated Node process preload' : 'Packaged runtime without Node sampler'
    : 'Isolated development instrumentation';
  diagnostics.smoke = smoke;
  const api = async (path, payload) => {
    if (!token) {
      assert.equal(payload, undefined, 'The product renderer fallback permits read-only checks');
      return page.evaluate(async target => {
        const response = await fetch(target, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error('Fixture read HTTP ' + response.status);
        return response.json();
      }, path);
    }
    const response = await fetch(origin + path, {
      headers: payload === undefined ? tokenHeaders : { ...tokenHeaders, 'Content-Type': 'application/json' },
      method: payload === undefined ? 'GET' : 'POST', body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error('API ' + path + ' HTTP ' + response.status);
    return response.json();
  };
  const mark = (label, details) => network.mark(label, details);
  const running = () => api('/api/agent/running');
  const sidebar = page.locator('.desktop-titlebar-sidebar-toggle').first();
  const panel = page.locator('.right-panel-toggle').first();
  const surface = name => page.locator('[data-chat-surface][data-session-id="' + fixture.sessions[name] + '"]');
  const row = name => page.locator('[data-session-drag-id="' + fixture.sessions[name] + '"]').first();
  const tool = name => page.locator('#workspace-' + name + '-tab');
  const host = name => page.locator('#workspace-' + name);
  const activeStreams = async () => await Promise.resolve(network.activeStreams());
  const serverSampling = async (action, phase, extra = {}) => {
    try {
      if (packagedControl) return await packagedSample({ action: action === 'ping' ? 'status' : action, phase, ...extra });
      if (packaged) return null;
      return await api('/api/perf-sample', { action, phase, ...extra });
    }
    catch (error) { diagnostics.serverSamplingError ??= []; diagnostics.serverSamplingError.push(error.message); }
  };
  const bounded = async (predicate, limitMs = 9000) => {
    const start = performance.now();
    while (performance.now() - start < limitMs) {
      const value = await predicate();
      if (value) return { at: Date.now(), elapsedMs: performance.now() - start, value };
      await sleep(50, undefined, { signal });
    }
    return { at: Date.now(), elapsedMs: performance.now() - start, timedOut: true };
  };
  const observeAction = async (kind, work, detail = {}) => {
    const startMs = performance.now();
    const action = { phase: activePhase, kind, startedAt: Date.now(), detail };
    const endNetwork = network.beginOperation?.(kind, kind === 'switch'
      ? { urlPattern: '/api/sessions/', method: 'GET' }
      : kind === 'stop' || kind === 'send' ? { urlPattern: '/api/agent/', method: 'POST' } : {});
    mark('ui-action-start', { kind, ...detail });
    try { return await renderer.action(kind, work); }
    catch (error) { action.error = error.message; throw error; }
    finally {
      action.receiptMs = performance.now() - startMs;
      action.finishedAt = Date.now();
      diagnostics.actions.push(action);
      endNetwork?.();
    }
  };
  const sidebarOpen = async () => {
    if (await sidebar.getAttribute('aria-expanded') === 'false') await sidebar.click();
  };
  const select = async name => {
    await sidebarOpen();
    const selection = row(name);
    const more = page.getByRole('button', { name: /^(Show \d+ more|显示更多（\d+ 个会话）)$/ }).first();
    for (let expanded = 0; expanded < 4 && !await selection.count() && await more.isVisible(); expanded++) {
      await more.click();
    }
    await selection.click();
    currentSession = name;
    await surface(name).locator('textarea').first().waitFor({ state: 'visible' });
  };
  const openTool = async name => {
    if (await panel.getAttribute('aria-expanded') !== 'true') await panel.click();
    if (await tool(name).isVisible()) await tool(name).click();
    else {
      await page.locator('#file-panel').getByRole('button', { name: /^(Open tool|打开工具)$/ }).click();
      await page.getByRole('menu').getByRole('menuitem').filter({
        has: page.getByText(toolNames[name], { exact: true }),
      }).click();
    }
    await host(name).waitFor({ state: 'visible' });
  };
  const getComposer = (name = currentSession) => surface(name).locator('textarea.chat-composer-textarea').first();
  const roomStatus = name => api('/api/agent/' + fixture.sessions[name] + '?view=progress');
  const serverActiveNames = async () => {
    const payload = await running();
    const runningIds = payload.runningSessionIds ?? [];
    return Object.keys(fixture.sessions).filter(name => runningIds.includes(fixture.sessions[name]));
  };
  const warmWrapper = async name => {
    const began = performance.now();
    const startAt = Date.now();
    if (!token) {
      await page.evaluate(async id => new Promise((resolve, reject) => {
        const source = new EventSource('/api/agent/' + id + '/events?transport=delta');
        const timer = setTimeout(() => { source.close(); reject(new Error('Timed out warming fixture wrapper')); }, 12_000);
        source.onmessage = event => {
          if (JSON.parse(event.data).type !== 'connected') return;
          clearTimeout(timer);
          source.close();
          resolve();
        };
      }), fixture.sessions[name]);
      return { startAt, connectedAt: Date.now(), connectedMs: performance.now() - began, transport: 'renderer EventSource prep' };
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(45_000)]);
    const response = await fetch(origin + '/api/agent/' + fixture.sessions[name] + '/events?transport=delta',
      { headers: tokenHeaders, signal: combined });
    assert.ok(response.ok);
    const reader = response.body.getReader();
    try {
      const decoder = new TextDecoder();
      let contents = '';
      for (;;) {
        const read = await reader.read();
        if (read.done) throw new Error('Warm-up SSE ended before connected');
        contents += decoder.decode(read.value, { stream: true });
        if (contents.includes('"type":"connected"')) {
          return { startAt, connectedAt: Date.now(), connectedMs: performance.now() - began, transport: 'Node HTTP SSE prep' };
        }
      }
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  };
  const stage = async (label, work, options = {}) => {
    try {
      await step(label, async () => {
        const state = { phase: label, startedAt: Date.now(), activeNamesAtStart: await serverActiveNames(),
          streamsAtStart: await activeStreams(), terminalCounterAtStart: await readFile(fixture.terminalCounter, 'utf8').catch(() => null) };
        diagnostics.phases.push(state);
        await serverSampling('start', label, options.server);
        let openedRenderer = false;
        let openedNetwork = false;
        try {
          await network.begin(label);
          openedNetwork = true;
          await renderer.begin(label, options.renderer);
          openedRenderer = true;
          activePhase = label;
          await work();
        }
        finally {
          if (openedRenderer) await renderer.end(label).catch(error => { state.rendererCloseError = error.message; });
          if (openedNetwork) await network.end(label);
          state.finishedAt = Date.now();
          state.activeNamesAtEnd = await serverActiveNames().catch(() => []);
          state.streamsAtEnd = await activeStreams();
          state.terminalCounterAtEnd = await readFile(fixture.terminalCounter, 'utf8').catch(() => null);
          state.server = await serverSampling('stop', label);
        }
      });
    } catch (error) {
      phaseErrors.push({ label, error: error.message });
    }
  };
  const startPrompt = async (name, held, options = {}) => {
    if (name !== currentSession) await select(name);
    const marker = (held ? 'HOLD' : 'SHORT') + ++modelSerial;
    const composer = getComposer(name);
    await composer.fill('PERF_REQUEST_' + marker + ' Continue a harmless synthetic response.');
    const send = surface(name).getByRole('button', { name: sendName });
    if (options.firstTimeoutMs) {
      let retried = false;
      const readiness = await bounded(async () => {
        const retry = surface(name).locator('.session-history-status').getByRole('button', { name: /^(Retry|重试)$/ });
        if (!retried && await retry.isVisible()) { retried = true; await retry.click(); }
        return await send.isEnabled();
      }, options.firstTimeoutMs);
      assert.ok(!readiness.timedOut, 'Initial fixture chat never became send-ready');
    }
    const started = Date.now();
    const click = () => send.click();
    if (options.measure) await observeAction('send', click, { name, marker });
    else await click();
    const first = await bounded(async () => await surface(name).getByText('PERF_FIRST_' + marker).first().isVisible(),
      options.firstTimeoutMs ?? 18_000);
    assert.ok(!first.timedOut, 'First assistant marker timed out for ' + marker + ' in ' + name);
    const modelCall = fixture.calls.find(call => call.marker === marker);
    assert.ok(modelCall);
    const observation = { phase: activePhase, name, marker, startAt: started, uiFirstAt: first.at,
      uiFirstBoundMs: first.at - started, modelRequestAt: modelCall.at, fixtureFirstAt: modelCall.firstAt,
      pollIntervalMs: 50, ...options.extra };
    diagnostics.firstResponses.push(observation);
    if (held) heldLaneMarkers.set(name, marker);
    if (!held) {
      await surface(name).getByRole('button', { name: sendName }).waitFor({ state: 'visible' });
    }
    return marker;
  };
  const finishAll = () => { for (const stream of fixture.streams.values()) stream.finish(); };
  const waitForIdle = async () => {
    await waitUntil(async () => (await serverActiveNames()).length === 0, 'fixture model streams and session runtime idle');
  };
  const runInteractions = async (count, names, expectedConcurrent = 1) => {
    for (let iteration = 0; iteration < count; iteration++) {
      signal.throwIfAborted();
      const destination = names.find(name => name !== currentSession);
      await observeAction('switch', async () => {
        await select(destination);
        await surface(destination).locator('[data-chat-entry-id]').first().waitFor({ state: 'visible', timeout: 15_000 });
      }, { destination, id: fixture.sessions[destination], receipt: 'Target chat history visibly rendered' });
      await observeAction('sidebar', async () => {
        const prior = await sidebar.getAttribute('aria-expanded');
        await sidebar.click();
        await page.waitForFunction(expected => document.querySelector('.desktop-titlebar-sidebar-toggle')?.getAttribute('aria-expanded') === expected,
          prior === 'true' ? 'false' : 'true');
      });
      await sidebarOpen();
      const composer = getComposer();
      await composer.focus();
      for (const key of ['p', 'i', 'o']) await observeAction('typing', () => page.keyboard.press(key), { key });
      const actual = await composer.inputValue();
      assert.ok(actual.endsWith('pio'), 'Typed input must reach the chat composer');
      await composer.fill('');
      const chatScroll = surface(currentSession).locator('.chat-scroll-container').first();
      await chatScroll.hover();
      const scrollStart = await chatScroll.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
      const scrollDelta = scrollStart.top > 200 ? -640 : 540;
      await observeAction('scroll', () => page.mouse.wheel(0, scrollDelta), { scrollStart, scrollDelta });
      if (iteration % 3 === 0) {
        const namesNow = await serverActiveNames();
        diagnostics.fixture.push({ phase: activePhase, iteration, at: Date.now(), namesNow, streams: await activeStreams() });
        assert.ok(namesNow.length >= expectedConcurrent, 'Too few concurrent running sessions: ' + namesNow.join(', '));
      }
      await sleep(120, undefined, { signal });
    }
  };
  const stop = async (name, reason) => {
    if (currentSession !== name) await select(name);
    const start = Date.now();
    const statusButton = surface(name).getByRole('button', { name: stopName });
    await statusButton.waitFor({ state: 'visible' });
    const [ui, service] = await Promise.all([
      bounded(async () => {
        const send = surface(name).getByRole('button', { name: sendName });
        return await send.isVisible();
      }),
      bounded(async () => !((await running()).runningSessionIds ?? []).includes(fixture.sessions[name])),
      observeAction('stop', () => statusButton.click(), { name, reason }),
    ]);
    const final = await roomStatus(name).catch(error => ({ readError: error.message }));
    const modelCall = fixture.calls.find(call => call.marker === heldLaneMarkers.get(name));
    diagnostics.stability.push({ kind: 'stop', phase: activePhase, name, reason, startedAt: start,
      ui: { ...ui, sinceClickMs: ui.at - start }, service: { ...service, sinceClickMs: service.at - start },
      uiVersusServiceMs: ui.at - service.at, finalWrapperAlive: final.running, finalIsStreaming: final.state?.isStreaming,
      finalActivity: final.state?.activity ?? null, modelSocketClosedAt: modelCall?.closedAt ?? null });
  };
  const interruptPackagedNetwork = async () => {
    const cdp = await page.context().newCDPSession(page);
    const conditions = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    const faultStartedAt = Date.now();
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { ...conditions, offline: true });
      await sleep(850, undefined, { signal });
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { ...conditions, offline: false }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    return { disconnectedAt: Date.now(), faultStartedAt, injected: 'Chromium renderer offline; prior SSE interruption requires old/new CDP evidence' };
  };
  try {
    await step('prepare-and-warm-routes', async () => {
      if (process.env.PIORA_PERF_SKIP_RELOAD !== '1'
        && (!packaged || process.env.PIORA_PERF_ENABLE_RELEASE_RELOAD === '1')) await reload();
      await api('/api/health');
      diagnostics.viewport = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        panelMode: document.querySelector('.app-shell')?.getAttribute('data-side-panel-mode'),
      }));
      await serverSampling('ping', 'setup');
      await select('Compile');
      await startPrompt('Compile', false, { firstTimeoutMs: 100_000 });
      await select('Lane 1');
      await select('Lane 2');
    });
    if (await panel.getAttribute('aria-expanded') === 'true') await panel.click();
    const baselineMarker = await startPrompt('Lane 1', true);
    await stage('baseline', async () => {
      assert.equal(await panel.getAttribute('aria-expanded'), 'false');
      await runInteractions(smoke ? 2 : 12, ['Lane 1', 'Lane 2'], 1);
    }, { renderer: { react: true } });
    fixture.streams.get(baselineMarker)?.finish();
    await waitForIdle();
    await stage('baseline-send', async () => {
      for (let index = 0; index < (smoke ? 1 : 4); index++) await startPrompt('Lane 1', false, { measure: true });
    }, { renderer: { react: true } });

    await step('prepare-workspace-tabs', async () => {
      const checkpoint = detail => writeFile(join(directory, 'workspace-setup.json'), JSON.stringify({ detail, at: Date.now() }) + '\n');
      await select('Lane 1');
      await openTool('browser');
      await checkpoint('browser-tool-selected');
      const address = host('browser').getByRole('combobox', { name: /^(Address|地址)$/ });
      const browserUrl = fixture.fixtureOrigin + '/browser';
      await address.fill(browserUrl);
      await address.press('Enter');
      const embedded = await waitUntil(() => getBrowser().contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url() === browserUrl), 'real native browser target');
      await embedded.getByRole('heading', { name: 'Local browser fixture' }).waitFor();
      await embedded.screenshot({ path: join(directory, 'native-browser-fixture.png'), timeout: 4_000 }).catch(() => {});
      await checkpoint('native-fixture-browser-loaded');
      await openTool('files');
      for (const name of fixture.inputFiles) {
        const explorer = host('files').locator('#piora-file-explorer');
        if (!await explorer.isVisible()) await host('files').getByRole('button', { name: /^(Explorer|文件浏览器)$/ }).click();
        const item = explorer.locator('[role="treeitem"][data-tree-label="' + name + '"]').first();
        await item.click();
        await host('files').locator('#piora-file-viewer').first().waitFor();
        await checkpoint('open-file-' + name);
      }
      await openTool('commands');
      await checkpoint('terminal-tool-selected');
      const terminal = host('commands').locator('.xterm-helper-textarea').first();
      if (!await terminal.count()) {
        await host('commands').getByRole('button', { name: /^(New terminal|新建终端)$/i }).first().click();
      }
      await terminal.waitFor({ state: 'attached' });
      await terminal.focus();
      const command = "1..1500 | ForEach-Object { Write-Output ('PERF-PTY-' + $_); [IO.File]::WriteAllText('"
        + fixture.terminalCounter.replaceAll("'", "''") + "', [string]$_); Start-Sleep -Milliseconds 240 }";
      await page.keyboard.insertText(command);
      await page.keyboard.press('Enter');
      await waitUntil(async () => Number(await readFile(fixture.terminalCounter, 'utf8').catch(() => '0')) >= 3, 'sustained terminal output counter');
      await host('commands').locator('.xterm-rows').getByText(/PERF-PTY-(?:2|3|4|5|6|7|8|9)\b/).first()
        .waitFor({ state: 'visible', timeout: 6_000 });
      await checkpoint('sustained-terminal-output-confirmed');
    });
    await step('start-four-concurrent-real-session-prompts', async () => {
      for (const lane of ['Lane 1', 'Lane 2', 'Lane 3', 'Lane 4']) await startPrompt(lane, true);
      const names = await serverActiveNames();
      assert.equal(names.length, 4, names.join(', '));
      assert.equal(fixture.streams.size, 4);
    });
    if (!smoke) {
      await stage('four-sessions-panel-hidden', async () => {
        if (await panel.getAttribute('aria-expanded') === 'true') await panel.click();
        await runInteractions(6, ['Lane 3', 'Lane 4'], 3);
      }, { renderer: { react: true } });
    }
    for (const [toolName, label] of [['commands', 'heavy-terminal'], ['files', 'heavy-files'], ['browser', 'heavy-browser']]) {
      await stage(label, async () => {
        await observeAction('panel-tab', () => openTool(toolName), { toolName });
        await waitUntil(async () => await tool(toolName).getAttribute('aria-selected') === 'true', 'selected workspace tab');
        const openToolTabs = await Promise.all(Object.keys(toolNames).map(async name => ({ name, visible: await tool(name).isVisible() })));
        assert.ok(openToolTabs.every(tab => tab.visible));
        const embedded = getBrowser().contexts().flatMap(context => context.pages())
          .find(candidate => candidate.url() === fixture.fixtureOrigin + '/browser');
        diagnostics.fixture.push({ phase: activePhase, openToolTabs, streams: await activeStreams(),
          running: await serverActiveNames(), fixtureStreaming: [...fixture.streams.keys()],
          nativeFixtureAlive: Boolean(embedded && !embedded.isClosed()) });
        if (toolName === 'files') await appendFile(join(fixture.cwd, fixture.inputFiles[1]), 'File watch stimulus\n');
        await select('Lane 4');
        await runInteractions(smoke ? 1 : 8, ['Lane 3', 'Lane 4'], 3);
        await screenshot(label + '.png').catch(() => {});
      }, { renderer: { react: true, trace: label === 'heavy-files' } });
    }

    await stage('heavy-state', async () => {
      await select('Lane 4');
      const status = surface('Lane 4').getByRole('button', { name: stopName });
      await status.waitFor();
      const beforeSwitch = await serverActiveNames();
      await observeAction('switch', () => select('Lane 3'), { destination: 'Lane 3' });
      await surface('Lane 3').getByRole('button', { name: stopName }).waitFor();
      const returnStart = Date.now();
      await observeAction('switch', () => select('Lane 4'), { destination: 'Lane 4' });
      const afterSwitch = await bounded(() => status.isVisible());
      diagnostics.stability.push({ kind: 'switch-away-and-back', startedAt: returnStart, beforeSwitch,
        serviceAfter: await serverActiveNames(), returnToStopControlMs: afterSwitch.at - returnStart, afterSwitch });
      const targetUrl = origin + '/api/agent/' + fixture.sessions['Lane 4'] + '/events?transport=delta';
      const beforeDisconnect = await activeStreams();
      const oldStream = beforeDisconnect.find(stream => stream.url === targetUrl);
      const streamedText = surface('Lane 4').getByText('PERF_FIRST_' + heldLaneMarkers.get('Lane 4')).first();
      const visibleReplyLength = async () => await streamedText.isVisible() ? (await streamedText.textContent()).length : null;
      const textLengthBefore = await visibleReplyLength();
      const lossStart = Date.now();
      assert.ok(oldStream, 'Need a measured SSE before cutting the stream');
      const cut = packagedControl ? { ...await packagedSample({ action: 'disconnect', sessionId: fixture.sessions['Lane 4'] }), disconnectedAt: Date.now() }
        : packaged ? await interruptPackagedNetwork()
        : await api('/api/perf-sample', { action: 'disconnect', sessionId: fixture.sessions['Lane 4'] });
      if (!packaged || packagedControl) assert.ok(cut.streamsEnded || cut.closed, 'No chat SSE was cut');
      const onlineAt = cut.disconnectedAt;
      const resumed = await bounded(async () => (await activeStreams()).find(stream => stream.url === targetUrl
        && stream.id !== oldStream?.id && stream.eventCount >= 2));
      diagnostics.stability.push({ kind: packaged && !packagedControl ? 'renderer-network-offline' : 'server-closed-chat-stream', targetUrl, beforeDisconnect, cut,
        oldStream, controlRequestMs: onlineAt - lossStart, onlineAt, resumed, serviceAfter: await serverActiveNames(),
        textLengthBefore, textLengthAfter: await visibleReplyLength(),
        stopStillVisible: await status.isVisible() });
      await stop('Lane 4', 'after stream reconnection');
      await stop('Lane 3', 'heavy termination');
      await startPrompt('Lane 3', true);
      await stop('Lane 2', 'heavy termination');
    }, { server: { profile: true }, renderer: { react: true } });
    finishAll();
    await waitForIdle();

    await stage('cold-hot', async () => {
      if (await panel.getAttribute('aria-expanded') === 'true') await panel.click();
      for (const suffix of smoke ? ['A'] : ['A', 'B', 'C']) {
        const cold = 'Cold ' + suffix;
        const hot = 'Warm ' + suffix;
        assert.equal((await roomStatus(cold)).running, false);
        assert.equal((await roomStatus(hot)).running, false);
        await warmWrapper(hot);
        const ready = await roomStatus(hot);
        assert.equal(ready.running, true, 'Warm uses an idle live AgentSessionWrapper');
        assert.equal(ready.state.isStreaming, false);
        for (const [kind, name] of suffix === 'B' ? [['warm', hot], ['cold', cold]] : [['cold', cold], ['warm', hot]]) {
          const preConnect = await roomStatus(name);
          assert.equal(preConnect.running, kind === 'warm');
          // Opening a chat loads slash commands and can create the wrapper before Send.
          // The matched SSE handshakes measure cold and hot directly, then the actual UI sends.
          const connected = await warmWrapper(name);
          await select(name);
          const before = await roomStatus(name);
          assert.equal(before.running, true);
          await startPrompt(name, false, { measure: true, extra: { kind, pair: suffix, wrapperBeforeConnect: preConnect.running,
            wrapperBeforeSend: before.running } });
          diagnostics.coldHot.push({ pair: suffix, kind, id: fixture.sessions[name], wrapperBeforeConnect: preConnect.running,
            wrapperBeforeSend: before.running, ...connected,
            capturedAt: Date.now() });
        }
      }
    }, { server: { sdkSpans: true }, renderer: { react: true } });
    const sweepPath = process.env.PIORA_PERF_PACKAGED_COLD_SWEEP;
    if (packaged && !smoke && sweepPath && packagedControl) {
      if (!token) phaseErrors.push({ label: 'packaged-cold-sweep', error: 'Out-of-renderer desktop authentication not available for independent HTTP sweep' });
      else {
        try {
          await step('packaged-cold-sweep', async () => {
            const { runPackagedColdSweep } = await import(pathToFileURL(sweepPath).href);
            const output = join(directory, 'cold-sweep');
            await mkdir(output);
            await runPackagedColdSweep({ origin, headers: tokenHeaders, agentDirectory: paths.agent, cwd: fixture.cwd,
              provider, model, serverDirectory: join(directory, 'server'), output });
          });
        } catch (error) { phaseErrors.push({ label: 'packaged-cold-sweep', error: error.message }); }
      }
    }
  } finally {
    finishAll();
    await network.save(join(directory, 'network.json')).catch(error => { diagnostics.networkSaveError = error.message; });
    await renderer.save(join(directory, 'renderer.json')).catch(error => { diagnostics.rendererSaveError = error.message; });
    await network.close?.().catch(() => {});
    await renderer.close?.().catch(() => {});
    await writeFile(join(directory, 'ui-evidence.json'), JSON.stringify({ ...diagnostics, phaseErrors,
      calls: fixture.calls, webRequests: fixture.webRequests, sessions: fixture.sessions }, null, 2) + '\n');
    if (phaseErrors.length) await screenshot('phase-failure.png').catch(() => {});
    const browserSession = await getBrowser().newBrowserCDPSession().catch(() => null);
    if (browserSession) {
      await browserSession.send('Browser.close').catch(() => {});
      try {
        await bounded(async () => {
          const file = await open(join(directory, 'netlog.raw.json'), 'r').catch(() => null);
          if (!file) return false;
          try {
            const size = (await file.stat()).size;
            if (size < 60) return false;
            const data = Buffer.alloc(60);
            await file.read(data, 0, data.length, size - data.length);
            return /\]\s*\}\s*$/.test(data.toString('utf8'));
          } finally { await file.close(); }
        }, 10_000);
      } catch {}
    }
  }
  assert.equal(phaseErrors.length, 0, JSON.stringify(phaseErrors));
}

export const performanceDiagnostic = {
  id: 'performance-diagnostic', mode: 'local-model-fixture',
  skipOnboardingForFixture: true,
  scope: 'Real Windows Electron and authenticated Next.js runtime, synthetic histories and deterministic loopback model streams.',
  coverage: ['warm single active task', 'matched cold and warm wrapper comparison', 'four concurrent model streams',
    'native embedded browser, real file watcher and real PowerShell PTY; workspace Tab rotation',
    'keyboard, click, session switching, scrolling, stop and controlled chat SSE cut/reconnect'],
  limits: ['real providers', 'production desktop packages', 'three simultaneously visible workspace panels in a single tool tab strip'],
  prepare,
  run,
};
