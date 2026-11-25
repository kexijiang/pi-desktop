import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the measurement directory containing server/ and optional cold-warm-raw.json');
const serverDirectory = join(directory, 'server');
const names = await readdir(serverDirectory);
const records = (await Promise.all(names.filter(file => /^server-\d+\.jsonl$/.test(file))
  .map(async file => (await readFile(join(serverDirectory, file), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)))).flat();
const cold = await readFile(join(directory, 'cold-warm-raw.json'), 'utf8').then(JSON.parse, error => {
  if (error.code !== 'ENOENT') throw error;
  return {};
});

function quantile(sorted, q) {
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const decimal = number => Number(number.toFixed(3));
  return { n: sorted.length, p50: decimal(quantile(sorted, 0.5)), p95: decimal(quantile(sorted, 0.95)), max: decimal(sorted.at(-1)), min: decimal(sorted[0]) };
}
function columns(rows) {
  const keys = [...new Set(rows.flatMap(Object.keys))].filter(key => rows.some(row => Number.isFinite(row[key])));
  return Object.fromEntries(keys.map(key => [key, summary(rows.map(row => row[key]))]));
}
function summarizeCpuProfile(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
  const samples = new Map();
  const modules = new Map();
  let sampledUs = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index];
    const elapsedUs = profile.timeDeltas?.[index] ?? 0;
    const node = byId.get(id);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const key = JSON.stringify({ fn: functionName || '(anonymous)', url, line: lineNumber + 1 });
    const tally = samples.get(key) ?? { count: 0, us: 0 };
    tally.count++;
    tally.us += elapsedUs;
    samples.set(key, tally);
    sampledUs += elapsedUs;
    for (let id = node.id; id !== undefined; id = parents.get(id)) {
      const frame = byId.get(id).callFrame;
      const url = decodeURIComponent(frame.url).replaceAll('\\', '/');
      const appModule = /\/(lib|app|hooks|components|extensions)\/[^?#\s]+\.[cm]?[jt]sx?\b/.exec(url)?.[0];
      if (!appModule || /node_modules/.test(url)) continue;
      modules.set(appModule, (modules.get(appModule) ?? 0) + elapsedUs);
      break;
    }
  }
  return {
    sampledUs,
    analyzedSamples: profile.samples.length,
    profileUs: profile.endTime - profile.startTime,
    bySelfTime: [...samples].sort((a, b) => b[1].us - a[1].us).slice(0, 80).map(([key, tally]) =>
      ({ ...JSON.parse(key), count: tally.count, ms: tally.us / 1000, samplePct: 100 * tally.us / sampledUs })),
    nearestAppModuleOnStack: [...modules].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([module, us]) => ({ module, ms: us / 1000, samplePct: 100 * us / sampledUs })),
  };
}
const profiles = Object.fromEntries(await Promise.all(names.filter(file => file.endsWith('.cpuprofile')).map(async file =>
  [file, summarizeCpuProfile(JSON.parse(await readFile(join(serverDirectory, file), 'utf8')))])));
const phases = records.filter(row => row.type === 'phase-stop').map(row => {
  const intervals = records.filter(record => record.type === 'interval' && row.phase === record.phase && row.pid === record.pid);
  return {
    phase: row.phase, pids: [row.pid], durationMs: row.durationMs, cpuMs: row.cpuMs, cpuOneCorePct: row.cpuOneCorePct,
    eventLoopUtilizationPct: row.utilization * 100, eventLoopMs: row.eventLoopMs, resolutionMs: row.resolutionMs, logicalCores: row.parallelism,
    rssStartBytes: row.start.memory.rss, rssEndBytes: row.end.memory.rss,
    rssPeakSampledBytes: Math.max(row.start.memory.rss, row.end.memory.rss, ...intervals.map(record => record.rssBytes)),
    heapStartBytes: row.start.memory.heapUsed, heapEndBytes: row.end.memory.heapUsed,
    heapPeakSampledBytes: Math.max(row.start.memory.heapUsed, row.end.memory.heapUsed, ...intervals.map(record => record.heapUsedBytes)),
    cpuOneCorePctPerSecond: summary(intervals.map(sample => sample.cpuOneCorePct)),
    worstWindows: intervals.sort((a, b) => b.eventLoopMs.max - a.eventLoopMs.max).slice(0, 6),
  };
});
const bootTypes = ['session-manager', 'session-manager-open', 'session-manager-create', 'settings-manager', 'extension-plan',
  'sdk-package-manager-resolve', 'mcp-controller', 'session-services', 'model-settings', 'model-scope', 'sdk-model-scope',
  'sdk-visible-models', 'session-from-services', 'extension-bind', 'bootstrap-cold-return'];
const httpPhases = Object.fromEntries(phases.map(phase => {
  const groups = new Map();
  const completed = records.filter(row => row.phase === phase.phase && row.type === 'http-finished' && !String(row.contentType ?? '').includes('text/event-stream'));
  for (const row of completed) {
    const key = row.method + ' ' + row.path.replaceAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/ig, '{session}');
    groups.set(key, [...(groups.get(key) ?? []), row.ms]);
  }
  return [phase.phase, { completed: completed.length, allNonStreamsMs: summary(completed.map(row => row.ms)),
    topRoutes: [...groups].map(([route, values]) => ({ route, qps: values.length * 1000 / phase.durationMs, ...summary(values) })).sort((a, b) => b.n - a.n) }];
}));
const newPackageRequests = records.filter(record => record.type === 'http-received' && record.path === '/api/agent/new' && record.phase === 'package-new-create');
const grouped = new Map();
const pairs = new Map();
let newRequestIndex = 0;
const traces = (cold.rows ?? []).map(row => {
  const tempId = records.find(record => record.type === 'bootstrap-cold-return' && record.realSessionId === row.id)?.sessionId;
  const createRequest = row.name === 'new-create' && newPackageRequests[newRequestIndex++];
  const own = records.filter(record => record.sessionId === row.id || tempId && record.sessionId === tempId || createRequest && record.requestId === createRequest.requestId);
  const last = type => own.findLast(record => record.type === type);
  const routeStage = own.find(record => record.type === 'http-received' && record.method === 'GET' && record.path.endsWith('/events'));
  const relevant = routeStage ? own.filter(record => record.requestId === routeStage.requestId) : own;
  const marks = Object.fromEntries(bootTypes.flatMap(type => {
    const span = relevant.find(record => record.type === type);
    return span ? [[row.prewarm ? 'prewarm-' + type : type, span.ms]] : [];
  }));
  const sse = last('route-sse-connected');
  const routePost = own.find(record => record.type === 'route-post-start' && record.commandType === 'submit_input');
  const ready = last('router-session-ready');
  const router = last('router-start-prompt');
  const ack = last('route-prompt-ack');
  const sdkStart = last('sdk-agent-start');
  const firstText = last('sdk-first-text');
  const sseText = last('route-sse-first-text');
  const post = own.find(record => record.type === 'http-received' && record.method === 'POST' && record.path === '/api/agent/' + row.id);
  const postFinished = post && own.find(record => record.type === 'http-finished' && record.requestId === post.requestId);
  const metrics = { ...marks, routeConnectedMs: sse?.ms, routeAckMs: ack?.ms,
    postToRouterStartMs: router && routePost ? router.monoMs - routePost.requestAt : undefined,
    routerAcceptedToStartMs: router?.sinceAcceptedMs, routerSessionResolveMs: ready?.ms,
    routerToSdkStartMs: sdkStart && router ? sdkStart.monoMs - router.monoMs : undefined,
    sdkStartToFirstTextMs: firstText && sdkStart ? firstText.monoMs - sdkStart.monoMs : undefined,
    sdkTextToSseMs: sseText && firstText ? sseText.monoMs - firstText.monoMs : undefined,
    clientConnectMs: row.connectedMs, clientAckMs: row.ackMs,
    clientPostToFirstTextMs: row.postFirstTextMs, clientConnectToFirstTextMs: row.lifecycleFirstTextMs, clientPostToDoneMs: row.postDoneMs, clientCreateApiMs: row.createApiMs,
    packagePostToFirstSendMs: post && sseText ? sseText.monoMs - post.monoMs : undefined,
    packagePostResponseMs: postFinished?.ms,
    packageResolveCacheHit: relevant.some(record => record.type === 'sdk-package-manager-resolve' && record.cacheHit) ? 1 : undefined,
    planCandidates: last('extension-plan')?.candidates, planEnabled: last('extension-plan')?.enabledExtensions,
    sdkLoaded: last('session-services')?.loadedExtensions, sdkLoadErrors: last('session-services')?.loadErrors,
  };
  const group = row.name;
  grouped.set(group, [...(grouped.get(group) ?? []), metrics]);
  if (Number.isInteger(row.pair)) pairs.set(row.pair, { ...pairs.get(row.pair), [group]: metrics });
  return { ...row, metrics };
});
function paired(a, b, skipFirst = false) {
  const rows = [];
  for (const [index, pair] of pairs) {
    if (skipFirst && index === 0 || !pair[a] || !pair[b]) continue;
    rows.push(Object.fromEntries(Object.keys(pair[a]).map(key => [key, pair[a][key] - pair[b][key]])));
  }
  return columns(rows);
}
const results = {
  quantileMethod: 'linear interpolation for scalar measurements; native histogram for eventLoopMs',
  phases, profiles, httpPhases, modelFirstTextMs: summary((cold.model ?? []).map(row => row.firstTextMs)),
  groups: Object.fromEntries([...grouped].map(([group, rows]) => [group, columns(rows)])),
  pairedDeltas: {
    coldMinusWarm: paired('cold', 'warm'),
    fullMinusOmitHeavy: paired('full', 'omit-heavy'),
    fullMinusCachedPlanHits: paired('full', 'cache-plan', true),
    fullMinusCachedSdkResolutionHits: paired('full', 'cache-resolve', true),
  },
  traces,
};
await writeFile(join(directory, 'server-summary.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ phases, groups: results.groups, pairedDeltas: results.pairedDeltas, modelFirstTextMs: results.modelFirstTextMs }, null, 2));
