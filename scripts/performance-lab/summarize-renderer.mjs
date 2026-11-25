import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sum = values => values.reduce((total, value) => total + value, 0);
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const by = (items, key) => Map.groupBy(items, key);

export function stats(items) {
  const values = items.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = value => values[Math.max(0, Math.ceil(value * values.length) - 1)];
  return { n: values.length, p50: round(percentile(0.5)), p95: round(percentile(0.95)),
    p99: round(percentile(0.99)), max: round(values.at(-1)), mean: round(average(values)) };
}

function interactionTiming(rows) {
  const longest = [...by(rows.filter(row => row.interactionId > 0), row => row.interactionId).values()]
    .map(group => group.reduce((first, next) => first.duration >= next.duration ? first : next));
  return {
    duration: stats(longest.map(event => event.duration)),
    inputDelay: stats(longest.map(event => event.processingStart - event.startTime)),
    eventProcessing: stats(longest.map(event => event.processingEnd - event.processingStart)),
    presentationApprox: stats(longest.map(event => Math.max(0, event.duration - (event.processingEnd - event.startTime)))),
  };
}

function traceStats(trace, label) {
  const events = trace.traceEvents ?? trace;
  const begin = events.find(event => event.name === 'piora-perf-phase-start:' + label);
  const end = events.findLast(event => event.name === 'piora-perf-phase-end:' + label && event.pid === begin?.pid);
  if (!begin || !end) return { events: events.length, phaseMarksFound: false };
  const window = events.filter(event => event.pid === begin.pid && event.tid === begin.tid && event.ph === 'X'
    && event.ts + event.dur > begin.ts && event.ts < end.ts);
  const eventMs = event => (Math.min(event.ts + event.dur, end.ts) - Math.max(event.ts, begin.ts)) / 1000;
  const eventNames = ['RunTask', 'ThreadControllerImpl::RunTask', 'UpdateLayoutTree', 'RecalculateStyles',
    'Layout', 'Paint', 'PrePaint', 'FunctionCall', 'EvaluateScript', 'EventDispatch', 'V8.GCScavenger',
    'FireAnimationFrame', 'TimerFire'];
  const names = Object.fromEntries(eventNames.map(name => {
    const matches = window.filter(event => event.name === name);
    return [name, { ...stats(matches.map(eventMs)), totalMs: round(sum(matches.map(eventMs))) }];
  }));
  const runTasks = window.filter(event => event.name === 'RunTask');
  const longTasks = runTasks.filter(event => eventMs(event) > 50).sort((left, right) => right.dur - left.dur)
    .slice(0, 8).map(task => ({
      offsetMs: round((task.ts - begin.ts) / 1000), durationMs: round(eventMs(task)),
      longestChildren: window.filter(event => event !== task && event.ts >= task.ts && event.ts + event.dur <= task.ts + task.dur)
        .sort((left, right) => right.dur - left.dur).slice(0, 8).map(event => ({
          name: event.name, durationMs: round(event.dur / 1000),
          detail: event.args?.data?.url ?? event.args?.data?.type ?? event.args?.data?.functionName,
        })),
    }));
  return { phaseMarksFound: true, events: events.length, pid: begin.pid, tid: begin.tid,
    phaseDurationMs: round((end.ts - begin.ts) / 1000), names, longTasks };
}

function profileStats(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
  const table = new Map();
  const sourceTable = new Map();
  const component = /\b(AppShell|SessionSidebar|ChatWindow|ChatHistory|ChatInput|MarkdownBody|RightPanel|BrowserPanel|FileExplorer|FileViewerContent|FileViewer|CommandPanel|TerminalSurface)\b/i;
  const add = (rows, key, elapsed) => rows.set(key, (rows.get(key) ?? 0) + elapsed);
  let idleMs = 0, unattributedMs = 0;
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const elapsed = (profile.timeDeltas?.[index] ?? 0) / 1000;
    const leaf = nodes.get(id)?.callFrame;
    if (leaf?.functionName === '(idle)') { idleMs += elapsed; continue; }
    const leafLabel = (leaf?.functionName || '(anonymous)') + (leaf?.url ? ' ' + leaf.url : '');
    add(sourceTable, leafLabel, elapsed);
    let cursor = id;
    let match;
    while (cursor && !match) {
      const frame = nodes.get(cursor)?.callFrame;
      match = component.exec(frame?.functionName ?? '');
      cursor = parents.get(cursor);
    }
    if (match) add(table, match[1], elapsed);
    else unattributedMs += elapsed;
  }
  const ordered = values => [...values].sort((left, right) => right[1] - left[1]).map(([name, ms]) => ({ name, ms: round(ms) }));
  return { n: profile.samples?.length ?? 0, durationMs: round((profile.endTime - profile.startTime) / 1000),
    idleMs: round(idleMs), unattributedMs: round(unattributedMs), activeSampledMs: round(unattributedMs + sum([...table.values()])),
    componentsDeepestExactFunction: ordered(table), topLeaves: ordered(sourceTable).slice(0, 18) };
}

export async function summarizeRenderer(path) {
  const input = JSON.parse(await readFile(path, 'utf8'));
  const renderer = input.renderer;
  const groups = [];
  for (const phase of input.phases) {
    if (!phase.start || !phase.end) continue;
    const actions = input.actions.filter(action => action.phase === phase.label);
    const inWindow = row => row.startTime >= phase.start.now && row.startTime < phase.end.now;
    const long = (renderer.longTasks ?? []).filter(row => inWindow(row) && row.duration > 50);
    const eventTiming = (renderer.eventTiming ?? []).filter(inWindow);
    const configs = Object.fromEntries([...by(actions, row => row.kind)].map(([kind, rows]) => {
      const ids = new Set(rows.map(row => row.id));
      const frames = (renderer.inputFrames ?? []).filter(row => ids.has(row.actionId));
      const duration = (row, endpoint) => Number.isFinite(row[endpoint]) ? row[endpoint] - row.timestamp : null;
      const types = Object.fromEntries([...by(frames, row => row.type)].map(([type, events]) => [type, {
        handlerWait: stats(events.map(row => duration(row, 'handlerAt'))),
        eventToFirstRaf: stats(events.map(row => duration(row, 'firstFrameAt'))),
        eventToSecondRaf: stats(events.map(row => duration(row, 'secondFrameAt'))),
      }]));
      const timed = eventTiming.filter(event => rows.some(row => event.startTime >= row.start.now && event.startTime <= (row.end?.now ?? -1)));
      return [kind, { rows: rows.length, errors: rows.filter(row => row.error).length,
        successfulHostAction: stats(rows.filter(row => !row.error).map(row => row.hostElapsedMs)),
        browserGestureMeasurements: types, eventTimingAtLeast16Ms: interactionTiming(timed) }];
    }));
    const commits = (renderer.reactCommits ?? []).filter(commit => commit.phase === phase.label);
    const targets = commits.flatMap(commit => commit.targets);
    const rootTotalMs = sum(commits.map(row => row.rootMs));
    const components = [...by(targets, row => row.name)].map(([name, rows]) => ({
      name, samples: rows.length, self: stats(rows.map(row => row.selfMs)),
      selfSumMs: round(sum(rows.map(row => row.selfMs))),
      inclusiveSumMs: round(sum(rows.map(row => row.inclusiveMs))),
      shareOfRootRender: rootTotalMs ? round(sum(rows.map(row => row.selfMs)) / rootTotalMs) : null,
    })).sort((left, right) => right.selfSumMs - left.selfSumMs);
    const capture = input.captures.find(row => row.label === phase.label);
    const durationMs = phase.end.now - phase.start.now;
    groups.push({
      label: phase.label, start: phase.start, end: phase.end, durationMs: round(durationMs), actions: configs,
      longTasks: { ...stats(long.map(row => row.duration)), perMinute: round(long.length * 60_000 / durationMs),
        tbtMs: round(sum(long.map(row => row.duration - 50))),
        top: long.sort((left, right) => right.duration - left.duration).slice(0, 8) },
      eventTimingAtLeast16Ms: interactionTiming(eventTiming),
      longFrames: (renderer.longFrames ?? []).filter(inWindow).sort((left, right) => right.blockingDuration - left.blockingDuration).slice(0, 8),
      react: { injected: renderer.injected ?? false, knownHookAlreadyPresent: renderer.existingHook ?? null,
        commits: commits.length, rootRenderMs: round(rootTotalMs), rootRenderDuration: stats(commits.map(row => row.rootMs)), components },
      trace: capture?.traceFile ? traceStats(JSON.parse(await readFile(join(dirname(path), capture.traceFile), 'utf8')), phase.label) : undefined,
      profile: capture?.profileFile ? profileStats(JSON.parse(await readFile(join(dirname(path), capture.profileFile), 'utf8'))) : undefined,
    });
  }
  return { evidence: path, estimators: 'Nearest rank. Event Timing 16ms floor. RAF measures scheduling to frames; CPU samples and React render only are separate estimators.',
    errors: input.errors, supported: renderer.supported, groups };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
  const result = await summarizeRenderer(process.argv[2]);
  const rendered = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[3]) await writeFile(process.argv[3], rendered);
  else process.stdout.write(rendered);
}
