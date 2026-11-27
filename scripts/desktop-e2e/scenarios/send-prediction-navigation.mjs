import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const provider = 'navigation-fixture';
const fixture = { chats: [], predictions: [], records: [] };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const sendPredictionNavigation = {
  id: 'send-prediction-navigation',
  mode: 'local-model-fixture',
  scope: 'real Windows Electron composer, sidebar, SDK model requests, session persistence and prediction API; synthetic sessions and loopback model only',
  coverage: ['send A while SSE handshake is delayed, then switch to B', 'late model success and failure preserve selected B and its draft', 'late prediction across conversation switches and manual typing', 'Tab accepts editable draft without sending'],
  limits: ['real providers and credentials', 'published installer', 'native OS keyboard input outside CDP', 'file search and Cookie migration'],
  async prepare({ paths, directory, registerCleanup, report }) {
    fixture.chats = []; fixture.predictions = []; fixture.records = [];
    fixture.cwd = join(directory, 'project');
    const sessions = join(paths.agent, 'sessions', '--navigation-fixture--');
    await mkdir(fixture.cwd); await mkdir(sessions, { recursive: true });
    for (const name of ['A', 'B']) {
      const id = randomUUID(), timestamp = new Date().toISOString();
      const rows = [
        { type: 'session', version: 3, id, cwd: fixture.cwd, timestamp },
        { type: 'model_change', id: '10000000', parentId: null, timestamp, provider, modelId: 'chat' },
        { type: 'message', id: '10000001', parentId: '10000000', timestamp, message: { role: 'user', content: `${name}_INITIAL_USER`, timestamp: Date.now() } },
      ];
      if (name === 'B') rows.push({ type: 'message', id: '10000002', parentId: '10000001', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'B_INITIAL_REPLY: The fixture is ready for another question.' }], timestamp: Date.now(), provider, model: 'chat', api: 'openai-completions', stopReason: 'stop', usage } });
      rows.push({ type: 'session_info', id: '10000003', parentId: name === 'B' ? '10000002' : '10000001', timestamp, name: `Navigation QA ${name}` });
      const file = join(sessions, `${timestamp.replaceAll(':', '-')}_${id}.jsonl`);
      await writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
      fixture[name] = { id, file };
    }
    const server = createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.ok(['chat', 'prediction'].includes(body.model), 'only the local fixture models may run');
        assert.ok(fixture.records.length < 16, 'unexpected model request loop');
        const record = { model: body.model, at: Date.now(), released: false, closed: false, text: JSON.stringify(body.messages) };
        fixture.records.push(record);
        response.on('close', () => { record.closed = true; });
        const release = (text, failure = false) => {
          record.released = true; record.releasedAt = Date.now(); record.closedBeforeRelease = response.destroyed;
          if (response.destroyed) return;
          if (failure) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: text, type: 'invalid_request_error', code: 'fixture_rejected' } })); return; }
          if (body.stream === false) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); return; }
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'navigation-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
          emit({ role: 'assistant', content: text }); emit({}, 'stop'); response.end('data: [DONE]\n\n');
        };
        (body.model === 'chat' ? fixture.chats : fixture.predictions).push({ record, release });
      } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    registerCleanup(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const models = ['chat', 'prediction'].map(id => ({ id, name: `Navigation ${id}`, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    await writeFile(join(paths.agent, 'models.json'), JSON.stringify({ providers: { [provider]: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', models } } }));
    const settingsFile = join(paths.agent, 'settings.json');
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
    await writeFile(settingsFile, JSON.stringify({ ...settings, defaultProvider: provider, defaultModel: 'chat', enabledModels: models.map(model => `${provider}/${model.id}`) }));
    report.fixture = { A: fixture.A.id, B: fixture.B.id, provider, source: 'synthetic history and local deterministic model; no real credentials' };
  },
  async run({ page, step, waitUntil, directory }) {
    const evidence = { submissions: [], predictions: [], observations: [] };
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      const path = new URL(request.url()).pathname, body = request.postDataJSON();
      if (['prompt', 'submit_input'].includes(body?.type)) evidence.submissions.push({ path, message: body.message, at: Date.now() });
      if (path.endsWith('/input-prediction')) evidence.predictions.push({ path, sourceEntryId: body.sourceEntryId, leafId: body.leafId, at: Date.now() });
    });
    const surface = name => page.locator(`[data-chat-surface][data-session-id="${fixture[name].id}"]`);
    const input = name => surface(name).locator('textarea').first();
    const send = name => surface(name).getByRole('button', { name: /^(Send|发送)$/, exact: true });
    const select = async name => {
      const row = page.locator(`[data-session-drag-id="${fixture[name].id}"]`);
      const show = page.getByRole('button', { name: /^(Show sidebar|显示侧边栏)$/ }).first();
      if (!await row.isVisible() && await show.isVisible()) await show.click();
      await row.click(); await surface(name).waitFor();
      await waitUntil(() => input(name).isEnabled(), `${name} composer ready`);
    };
    const assertDraft = async (name, value) => {
      assert.equal(await surface(name).isVisible(), true, `${name} must remain selected`);
      assert.equal(await input(name).inputValue(), value);
      evidence.observations.push({ name, value, at: Date.now() });
    };
    const screenshot = name => page.screenshot({ path: join(directory, name), animations: 'disabled', timeout: 30000 });
    const persisted = async text => (await readFile(fixture.A.file, 'utf8')).includes(text);
    let releaseSse;
    try {
      await step('prepare-two-synthetic-chats', async () => {
        // Read-only warm-up prevents cold dev compilation from consuming the UI hydration deadline.
        await page.evaluate(async ids => {
          for (const id of ids) for (const path of [
            `/api/sessions/${id}?deferThinking=1&deferMedia=1`, `/api/sessions/${id}/state?view=chat`, `/api/agent/${id}`,
            `/api/sessions/${id}/permissions`, `/api/sessions/${id}/tool-reviews`,
            `/api/agent/${id}/workflow`, `/api/agent/${id}/changes`, `/api/agent/${id}/browser-wait`,
            `/api/sessions/${id}/submissions?view=operations&offset=0&scope=chat`, `/api/rooms`,
            `/api/sessions/${id}/input-prediction`,
          ]) {
            // GET on the POST-only prediction endpoint compiles it without generating anything.
            const response = await fetch(path); if (!response.ok && response.status !== 405) throw new Error(`Fixture warmup ${response.status}`); await response.text();
          }
        }, [fixture.A.id, fixture.B.id]);
        await select('B'); await input('B').fill('B preserved draft');
        await select('A');
      });
      await step('send-switch-and-late-success', async () => {
        let observed = false;
        const gate = new Promise(resolve => { releaseSse = resolve; });
        const pattern = `**/api/agent/${fixture.A.id}/events?**`;
        const hold = async route => { observed = true; await gate; await route.continue().catch(() => {}); };
        await page.route(pattern, hold);
        await input('A').fill('NAVIGATION_SUCCESS'); await waitUntil(() => send('A').isEnabled(), 'A send enabled'); await send('A').click();
        await waitUntil(() => observed, 'real SSE handshake intercepted');
        await select('B'); await assertDraft('B', 'B preserved draft');
        releaseSse(); await page.unroute(pattern, hold);
        const call = await waitUntil(() => fixture.chats[0], 'A submission reaches local model after switching');
        assert.ok(call.record.text.includes('NAVIGATION_SUCCESS'));
        call.release('A_SUCCESS_COMPLETED');
        await waitUntil(() => persisted('A_SUCCESS_COMPLETED'), 'A reply persisted');
        await assertDraft('B', 'B preserved draft'); await screenshot('success-remains-on-b.png');
        assert.equal(evidence.submissions.length, 1); assert.ok(evidence.submissions[0].path.endsWith(fixture.A.id));
        await select('A'); await surface('A').getByText('A_SUCCESS_COMPLETED', { exact: true }).waitFor();
      });
      await step('send-switch-and-late-failure', async () => {
        await input('A').fill('NAVIGATION_FAILURE'); await waitUntil(() => send('A').isEnabled(), 'A ready after success'); await send('A').click();
        await select('B'); await assertDraft('B', 'B preserved draft');
        const call = await waitUntil(() => fixture.chats[1], 'second A submission reaches local model');
        assert.ok(call.record.text.includes('NAVIGATION_FAILURE'));
        call.release('FIXTURE_MODEL_REJECTED', true);
        await waitUntil(() => persisted('FIXTURE_MODEL_REJECTED'), 'A model failure persisted');
        await assertDraft('B', 'B preserved draft'); await screenshot('failure-remains-on-b.png');
        await select('A');
        await surface('A').locator('details').filter({ hasText: 'FIXTURE_MODEL_REJECTED' }).locator('summary').click();
        await surface('A').getByText(/FIXTURE_MODEL_REJECTED/).first().waitFor();
        assert.equal(evidence.submissions.length, 2); assert.ok(evidence.submissions.every(row => row.path.endsWith(fixture.A.id)));
      });
      await step('late-prediction-after-session-switch', async () => {
        await select('B'); await assertDraft('B', 'B preserved draft'); await input('B').fill('');
        // Fixture preference setup; all acceptance/typing/switching actions are UI operations.
        await page.evaluate(provider => {
          localStorage.setItem('piora-input-prediction-v2', JSON.stringify({ enabled: true, model: { provider, modelId: 'prediction' }, timeoutMs: 120000 }));
          window.dispatchEvent(new Event('piora:input-prediction'));
        }, provider);
        const call = await waitUntil(() => fixture.predictions[0], 'B prediction starts');
        await select('A'); await input('A').fill('A manually typed draft');
        call.release('STALE_B_PREDICTION');
        await page.waitForTimeout(1200);
        await assertDraft('A', 'A manually typed draft');
        assert.notEqual(await input('A').getAttribute('placeholder'), 'STALE_B_PREDICTION');
        await screenshot('late-prediction-does-not-change-a.png');
      });
      await step('late-prediction-after-manual-typing', async () => {
        await select('B');
        const call = await waitUntil(() => fixture.predictions[1], 'returning B requests prediction again');
        await input('B').fill('B manually typed draft');
        call.release('STALE_TYPING_PREDICTION');
        await page.waitForTimeout(1200);
        await assertDraft('B', 'B manually typed draft');
        assert.notEqual(await input('B').getAttribute('placeholder'), 'STALE_TYPING_PREDICTION');
      });
      await step('tab-accepts-only-an-editable-draft', async () => {
        await input('B').fill('');
        // A prediction for the same source may be cached even when its display
        // was cancelled by typing. Cache reuse must not be mistaken for failure.
        await waitUntil(async () => fixture.predictions[2] || await input('B').getAttribute('aria-keyshortcuts') === 'Tab', 'a fresh or cached prediction is available');
        const call = fixture.predictions[2];
        const text = call ? 'Please expand the fixture explanation.' : await input('B').getAttribute('placeholder');
        assert.ok(text);
        call?.release(text);
        evidence.acceptedPrediction = { text, source: call ? 'fresh' : 'cache' };
        await surface('B').getByPlaceholder(text, { exact: true }).waitFor();
        assert.equal(await input('B').inputValue(), '');
        const before = evidence.submissions.length;
        await input('B').press('Tab');
        assert.equal(await input('B').inputValue(), text);
        await input('B').fill(`${text} Edited by hand.`);
        await select('A'); await assertDraft('A', 'A manually typed draft');
        await select('B'); await assertDraft('B', `${text} Edited by hand.`);
        await page.waitForTimeout(1200);
        assert.equal(evidence.submissions.length, before, 'Tab and editing must never send a prompt');
        assert.equal(fixture.chats.length, 2); await screenshot('tab-accepted-editable-draft.png');
      });
    } finally {
      releaseSse?.();
      await writeFile(join(directory, 'navigation-evidence.json'), JSON.stringify({ ...evidence, modelRequests: fixture.records }, null, 2));
    }
  },
};
