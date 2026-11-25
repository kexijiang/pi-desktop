import { dirname, basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';

function instrumentRenderer() {
  if (window.__PIORA_PERF_RENDERER__) return;
  const componentNames = new Set([
    'AppShell', 'SessionSidebar', 'ChatWindow', 'ChatHistory', 'ChatInput', 'MarkdownBody',
    'RightPanel', 'BrowserPanel', 'FileExplorer', 'FileViewer', 'FileViewerContent',
    'CommandPanel', 'TerminalSurface',
  ]);
  const state = window.__PIORA_PERF_RENDERER__ = {
    phase: null, action: null, longTasks: [], eventTiming: [], longFrames: [], inputFrames: [],
    reactCommits: [], injected: false, existingHook: Boolean(window.__REACT_DEVTOOLS_GLOBAL_HOOK__),
    origin: performance.timeOrigin, supported: PerformanceObserver.supportedEntryTypes,
  };
  const observers = [];
  const recordEntries = (type, list, project, options = {}) => {
    if (!state.supported.includes(type)) return;
    const observer = new PerformanceObserver(entries => {
      for (const entry of entries.getEntries()) list.push(project(entry));
    });
    observer.observe({ type, ...options });
    observers.push(() => {
      for (const entry of observer.takeRecords()) list.push(project(entry));
    });
  };
  recordEntries('event', state.eventTiming, entry => ({
    name: entry.name, startTime: entry.startTime, duration: entry.duration,
    processingStart: entry.processingStart, processingEnd: entry.processingEnd,
    interactionId: entry.interactionId,
  }), { durationThreshold: 16 });
  recordEntries('longtask', state.longTasks, entry => ({
    startTime: entry.startTime, duration: entry.duration, name: entry.name,
  }));
  recordEntries('long-animation-frame', state.longFrames, entry => ({
    startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration,
    renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
    scripts: [...(entry.scripts ?? [])].map(script => ({
      duration: script.duration, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
      sourceFunctionName: script.sourceFunctionName, sourceURL: script.sourceURL,
      invoker: script.invoker, invokerType: script.invokerType,
    })),
  }));
  state.drain = () => { for (const drain of observers) drain(); };
  for (const type of ['click', 'input', 'keydown', 'wheel']) {
    window.addEventListener(type, event => {
      if (!event.isTrusted || !state.phase || !state.action) return;
      const observation = {
        phase: state.phase, actionId: state.action.id, kind: state.action.kind, type,
        timestamp: event.timeStamp, handlerAt: performance.now(), firstFrameAt: null, secondFrameAt: null,
      };
      state.inputFrames.push(observation);
      requestAnimationFrame(() => {
        observation.firstFrameAt = performance.now();
        requestAnimationFrame(() => { observation.secondFrameAt = performance.now(); });
      });
    }, { capture: true, passive: true });
  }
  let rendererCount = 0;
  const previousCommits = new WeakMap();
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ?? {
    renderers: new Map(),
    supportsFiber: true,
    inject(internals) {
      const id = ++rendererCount;
      this.renderers.set(id, internals);
      state.injected = true;
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
  };
  const originalCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (...args) {
    try { return originalCommit?.apply(this, args); }
    finally {
      const root = args[1];
      if (root) {
        state.injected = true;
        recordCommit(root);
      }
    }
  };
  if (!state.existingHook) window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

  function recordCommit(root) {
        const finishedAt = performance.now();
        const previousCommit = previousCommits.get(root) ?? 0;
        previousCommits.set(root, finishedAt);
        if (!state.phase?.react) return;
        const fiber = root.current;
        if (!(fiber?.actualDuration > 0)) return;
        const targets = [];
        const fresh = child => Number.isFinite(child.actualStartTime) && child.actualStartTime >= previousCommit;
        const children = [fiber];
        while (children.length) {
          const node = children.pop();
          if (node.sibling) children.push(node.sibling);
          if (node.child) children.push(node.child);
          if ((node.flags & 1) === 0 || !fresh(node)) continue;
          const type = node.type;
          const name = typeof type === 'function' ? type.name
            : type?.render?.name ?? type?.type?.name ?? type?.displayName;
          if (!componentNames.has(name)) continue;
          let nested = 0;
          for (let child = node.child; child; child = child.sibling) {
            if (fresh(child)) nested += child.actualDuration ?? 0;
          }
          targets.push({
            name,
            selfMs: Math.max(0, node.actualDuration - nested),
            inclusiveMs: node.actualDuration,
          });
        }
        state.reactCommits.push({
          phase: state.phase.label, actionId: state.action?.id ?? null,
          at: finishedAt, rootMs: fiber.actualDuration, targets,
        });
  }
}

const traceCategories = [
  'toplevel', 'devtools.timeline', 'blink.user_timing', 'latencyInfo',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
].join(',');

async function writeTrace(cdp, stream, path) {
  const file = createWriteStream(path);
  try {
    while (true) {
      const block = await cdp.send('IO.read', { handle: stream, size: 1_048_576 });
      if (!file.write(block.data, block.base64Encoded ? 'base64' : 'utf8')) await once(file, 'drain');
      if (block.eof) break;
    }
    file.end();
    await once(file, 'finish');
  } finally {
    file.destroy();
    await cdp.send('IO.close', { handle: stream }).catch(() => undefined);
  }
}

export async function attachPerfRenderer(page) {
  const cdp = await page.context().newCDPSession(page);
  await page.addInitScript(instrumentRenderer);
  await page.evaluate(instrumentRenderer);
  const actions = [];
  const phases = [];
  const captures = new Map();
  const errors = [];
  let phase;
  let serial = 0;
  let savedIndex = 0;

  async function begin(label, options = {}) {
    if (phase) throw new Error('Renderer phase already started: ' + phase.label);
    phase = { label, trace: Boolean(options.trace), react: options.react !== false };
    if (phase.trace) {
      const capture = {};
      try {
        await cdp.send('Tracing.start', { categories: traceCategories, transferMode: 'ReturnAsStream' });
        capture.traceStarted = true;
      } catch (error) { errors.push({ label, stage: 'trace-start', message: error.message }); }
      try {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 2_000 });
        await cdp.send('Profiler.start');
        capture.profileStarted = true;
      } catch (error) { errors.push({ label, stage: 'profile-start', message: error.message }); }
      captures.set(label, capture);
    }
    phase.start = await page.evaluate(description => {
      const state = window.__PIORA_PERF_RENDERER__;
      state.phase = description;
      const now = performance.now();
      performance.mark('piora-perf-phase-start:' + description.label);
      return { now, epochMs: performance.timeOrigin + now, visible: document.visibilityState };
    }, { label, react: phase.react });
    phases.push(phase);
  }

  async function end(label) {
    if (phase?.label !== label) return;
    const stopPhase = phase;
    phase = undefined;
    stopPhase.end = await page.evaluate(description => {
      const state = window.__PIORA_PERF_RENDERER__;
      const now = performance.now();
      performance.mark('piora-perf-phase-end:' + description);
      state.phase = null;
      state.action = null;
      return { now, epochMs: performance.timeOrigin + now, visible: document.visibilityState };
    }, label);
    const capture = captures.get(label);
    if (!capture) return;
    if (capture.profileStarted) {
      try { ({ profile: capture.profile } = await cdp.send('Profiler.stop')); }
      catch (error) { errors.push({ label, stage: 'profile-stop', message: error.message }); }
      capture.profileStarted = false;
    }
    if (capture.traceStarted) {
      let timer;
      try {
        const completed = new Promise((resolve, reject) => {
          const handler = output => { clearTimeout(timer); resolve(output); };
          cdp.once('Tracing.tracingComplete', handler);
          timer = setTimeout(() => {
            cdp.off('Tracing.tracingComplete', handler);
            reject(new Error('Timed out collecting Chromium trace stream'));
          }, 10_000);
        });
        try {
          await cdp.send('Tracing.end');
          const result = await completed;
          capture.stream = result.stream;
          capture.dataLossOccurred = result.dataLossOccurred ?? false;
        } catch (error) {
          clearTimeout(timer);
          void completed.catch(() => undefined);
          throw error;
        }
      } catch (error) { errors.push({ label, stage: 'trace-stop', message: error.message }); }
      capture.traceStarted = false;
    }
  }

  async function action(kind, work) {
    const id = ++serial;
    const row = { id, kind, phase: phase?.label ?? null };
    row.start = await page.evaluate(data => {
      const state = window.__PIORA_PERF_RENDERER__;
      state.action = data;
      const now = performance.now();
      performance.mark('piora-perf-action:' + data.id + ':' + data.kind);
      return { now, epochMs: performance.timeOrigin + now };
    }, { id, kind });
    actions.push(row);
    const start = performance.now();
    try { return await work(); }
    catch (error) { row.error = error.message; throw error; }
    finally {
      row.hostElapsedMs = performance.now() - start;
      row.end = await page.evaluate(serial => {
        const state = window.__PIORA_PERF_RENDERER__;
        if (state.action?.id === serial) state.action = null;
        const now = performance.now();
        return { now, epochMs: performance.timeOrigin + now };
      }, id).catch(() => null);
    }
  }

  async function save(filepath) {
    if (phase) await end(phase.label).catch(error => errors.push({ stage: 'end-at-save', message: error.message }));
    for (const [label, capture] of captures) {
      if (capture.saved) continue;
      const prefix = basename(filepath, '.json') + '-' + label.replace(/[^a-z0-9-]+/gi, '-') + '-' + (++savedIndex);
      if (capture.profile) {
        capture.profileFile = prefix + '.cpuprofile';
        await writeFile(join(dirname(filepath), capture.profileFile), JSON.stringify(capture.profile));
      }
      if (capture.stream) {
        capture.traceFile = prefix + '.trace.json';
        try { await writeTrace(cdp, capture.stream, join(dirname(filepath), capture.traceFile)); }
        catch (error) { errors.push({ label, stage: 'trace-write', message: error.message }); }
      }
      capture.saved = true;
    }
    const renderer = await page.evaluate(() => {
      const state = window.__PIORA_PERF_RENDERER__;
      state.drain();
      const { origin, supported, injected, existingHook, longTasks, eventTiming, longFrames, inputFrames, reactCommits } = state;
      return { origin, supported, injected, existingHook, longTasks, eventTiming, longFrames, inputFrames, reactCommits };
    }).catch(error => { errors.push({ stage: 'renderer-read', message: error.message }); return {}; });
    await writeFile(filepath, JSON.stringify({
      phases, actions, errors, renderer, captures: [...captures].map(([label, capture]) => ({
        label, profileFile: capture.profileFile, traceFile: capture.traceFile, dataLossOccurred: capture.dataLossOccurred,
      })),
    }, null, 2) + '\n');
  }

  return { begin, end, action, save };
}
