import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [cdpFile, netLogFile, output] = process.argv.slice(2);
const cdp = JSON.parse(await readFile(cdpFile, "utf8"));
const netLog = netLogFile === "-" ? null : JSON.parse(await readFile(netLogFile, "utf8"));
const scenarioResult = await readFile(join(dirname(cdpFile), "result.json"), "utf8").then(JSON.parse).catch(() => ({}));
const fixtureSessions = scenarioResult.fixture?.sessions ?? {};
const isStream = request => request.type === "EventSource" || request.mime === "text/event-stream";
const round = value => Math.round(value * 1000) / 1000;
function describe(input) {
  const sorted = input.filter(Number.isFinite).sort((first, second) => first - second);
  const quantile = q => sorted.length === 0 ? null : round(sorted[Math.ceil(sorted.length * q) - 1]);
  return { n: sorted.length, p50: quantile(.5), p95: quantile(.95), max: quantile(1) };
}
function lowCardinalityPath(url) {
  return new URL(url).pathname.replace(/\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?=\/|$)/ig, "/:id")
    .replace(/(\/api\/shell\/sessions\/)[^/]+/g, "$1:id");
}
function sampleTimings(requests) {
  return {
    observations: requests.length,
    finished: requests.filter(item => item.finishedAt !== undefined && !item.error).length,
    errored: requests.filter(item => item.error).length,
    inFlightOrCensored: requests.filter(item => item.finishedAt === undefined).length,
    queuedMs: describe(requests.map(item => item.metrics.queuedMs)),
    stalledMs: describe(requests.map(item => item.metrics.stalledMs)),
    blockedMs: describe(requests.map(item => item.metrics.blockedMs)),
    afterSendToHeadersMs: describe(requests.map(item => item.metrics.afterSendToHeadersMs)),
    headerMs: describe(requests.map(item => item.metrics.headerMs)),
    totalMs: describe(requests.filter(item => !item.error).map(item => item.metrics.totalMs)),
  };
}
const linkedEntries = new Map(cdp.requests.map(request => [request.id, request]));
const nativeByRequest = new Map();
const nativePairing = [];
for (const event of netLog?.findings.originStalls ?? []) {
  if (!event.url || !Number.isFinite(event.requestStartTick)) continue;
  const nativeRequestStart = event.requestStartTick + netLog.timeTickOffsetMs;
  const candidates = cdp.requests.filter(request => request.url === event.url && request.method === event.method
    && request.startedWallMs <= event.wallMs + 3 && (request.responseWallMs ?? request.finishedWallMs ?? Infinity) >= event.wallMs - 3)
    .map(request => ({ request, delta: Math.abs(nativeRequestStart - (request.startedWallMs
      + ((request.timing?.requestTime ?? request.started) - request.started) * 1000)) }))
    .filter(candidate => candidate.delta <= 20).sort((a, b) => a.delta - b.delta);
  if (candidates.length === 0 || (candidates.length > 1 && candidates[1].delta - candidates[0].delta < 2)) continue;
  const { request, delta } = candidates[0];
  const linked = { ...event, cdpRequestId: request.id, startClockDifferenceMs: round(delta) };
  const entries = nativeByRequest.get(request.id) ?? [];
  entries.push(linked);
  nativeByRequest.set(request.id, entries);
  nativePairing.push(linked);
}

function nativeWaitFor(request) {
  const waits = (nativeByRequest.get(request.id) ?? []).filter(sample => Number.isFinite(sample.socketBoundTick))
    .sort((a, b) => a.stallTick - b.stallTick);
  let end = -Infinity;
  let waitMs = 0;
  for (const sample of waits) {
    waitMs += Math.max(0, sample.socketBoundTick - Math.max(sample.stallTick, end));
    end = Math.max(end, sample.socketBoundTick);
  }
  return waitMs;
}

function criticalPath(requests) {
  const eligible = requests.filter(request => !request.error && request.metrics.totalMs > 0
    && Number.isFinite(request.metrics.blockedMs));
  const totalMs = eligible.reduce((total, request) => total + request.metrics.totalMs, 0);
  const sumBlocked = eligible.reduce((total, request) => total + request.metrics.blockedMs, 0);
  const sumNative = eligible.reduce((total, request) => total + nativeWaitFor(request), 0);
  return {
    n: eligible.length,
    cdpBlockedSharePct: totalMs > 0 ? round(100 * sumBlocked / totalMs) : null,
    matchedPoolWaitSharePct: netLog && totalMs > 0 ? round(100 * sumNative / totalMs) : null,
    pairedRequestsWithKnownPoolWait: eligible.filter(request => nativeWaitFor(request) > 0).length,
  };
}

function statistics(label, groups) {
  const issuedInWindow = time => groups.some(group => time >= group.startMs && time < group.endMs);
  const duration = groups.reduce((sum, group) => sum + group.intervalSeconds, 0);
  const all = cdp.requests.filter(request => issuedInWindow(request.startedWallMs) && !isStream(request));
  const chatStreams = cdp.requests.filter(request => issuedInWindow(request.startedWallMs) && isStream(request)
    && new URL(request.url).searchParams.get("transport") === "delta");
  const byEndpoint = new Map();
  for (const request of all) {
    const endpoint = request.method + " " + lowCardinalityPath(request.url);
    const list = byEndpoint.get(endpoint) ?? [];
    list.push(request);
    byEndpoint.set(endpoint, list);
  }
  const byAction = new Map();
  for (const action of groups.flatMap(group => group.operations)) {
    const stats = byAction.get(action.label) ?? { actions: 0, withRequests: 0, requestKeys: new Set(), endpoints: new Map(),
      targetMatchedActions: 0, targetMatchedKeys: new Set() };
    const mark = cdp.markers.find(marker => marker.label === "ui-action-start" && marker.details?.kind === action.label
      && marker.atMs >= action.startMs && marker.atMs <= (action.endMs ?? action.startMs));
    const sessionName = mark?.details?.destination ?? mark?.details?.name;
    const targetSession = sessionName ? fixtureSessions[sessionName] : undefined;
    stats.actions++;
    if (action.requests.length) stats.withRequests++;
    if (targetSession) stats.targetMatchedActions++;
    for (const request of action.requests) {
      stats.requestKeys.add(request.id);
      const endpoint = request.method + " " + lowCardinalityPath(request.url);
      stats.endpoints.set(endpoint, (stats.endpoints.get(endpoint) ?? 0) + 1);
      if (targetSession && new URL(request.url).pathname.split("/")[3] === targetSession) {
        stats.targetMatchedKeys.add(request.id);
      }
    }
    byAction.set(action.label, stats);
  }
  const sortedByBlocked = all.filter(request => Number.isFinite(request.metrics.blockedMs))
    .sort((a, b) => b.metrics.blockedMs - a.metrics.blockedMs).slice(0, 8);
  const sortedByTotal = all.filter(request => Number.isFinite(request.metrics.totalMs) && !request.error)
    .sort((a, b) => b.metrics.totalMs - a.metrics.totalMs).slice(0, 8);
  const details = request => ({
    id: request.id, method: request.method, url: request.url, status: request.status, startedWallMs: request.startedWallMs,
    ...request.metrics,
    matchedNativePoolEvents: nativeByRequest.get(request.id) ?? [],
    concurrentStreamUrlsInRenderer: cdp.requests.filter(other => isStream(other) && other.status === 200
      && other.responseWallMs <= request.startedWallMs && (other.finishedWallMs ?? Infinity) > request.startedWallMs).map(other => other.url),
  });
  const peakCDP = [...groups].sort((a, b) => b.streaming.peakOpenStreams - a.streaming.peakOpenStreams)[0]?.streaming ?? null;
  const netMeasurement = (netLog?.findings?.measurements ?? []).filter(sample => groups.some(group => group.label === sample.label));
  const candidates = netMeasurement.map(sample => sample.streaming).filter(Boolean);
  const peakNetLog = candidates.sort((a, b) => b.peakOpenStreams - a.peakOpenStreams)[0] ?? null;
  const nativeSamples = netMeasurement.flatMap(sample => sample.samples);
  const socketOccupancy = new Map();
  for (const sample of nativeSamples) {
    const sockets = sample.groupSocketOccupancy ?? [];
    const streams = sockets.filter(socket => socket.streamingSse).length;
    const key = sockets.length + " sockets, " + streams + " SSE";
    socketOccupancy.set(key, (socketOccupancy.get(key) ?? 0) + 1);
  }
  return {
    label, phases: groups.map(group => group.label), durationSec: round(duration), combinedTimings: sampleTimings(all),
    criticalPath: criticalPath(all),
    chatStreamSetup: {
      issued: chatStreams.length,
      blockedMs: describe(chatStreams.map(request => request.metrics.blockedMs)),
      headerMs: describe(chatStreams.map(request => request.metrics.headerMs)),
      firstEventSourceMessageMs: describe(chatStreams.map(request => (request.firstEventAt - request.started) * 1000)),
      semantics: "First EventSource delivery includes connected/control frames and is not first assistant text.",
    },
    peaks: { cdp: peakCDP ? { n: peakCDP.peakOpenStreams, knownSockets: peakCDP.peakDistinctKnownConnections, snapshot: peakCDP.peakSnapshot } : null,
      chromiumNetLog: peakNetLog },
    nativePoolEvents: netLog ? netMeasurement.reduce((sum, sample) => sum + sample.perOriginGroupStallEvents, 0) : null,
    globalPoolEvents: netLog ? netMeasurement.reduce((sum, sample) => sum + sample.globalSocketPoolStallEvents, 0) : null,
    nativeUntilSocketBoundMs: describe(nativeSamples.map(sample => sample.untilSocketBoundMs)),
    nativeSocketOccupancyAtStall: Object.fromEntries(socketOccupancy),
    endpointQps: [...byEndpoint.entries()].map(([endpoint, samples]) => ({
      endpoint, requests: samples.length, qps: duration > 0 ? round(samples.length / duration) : null, ...sampleTimings(samples),
    })).sort((a, b) => b.requests - a.requests),
    byAction: [...byAction.entries()].map(([kind, stat]) => ({ kind, actions: stat.actions, withRequests: stat.withRequests,
      nativePoolEvents: [...stat.requestKeys].flatMap(id => nativeByRequest.get(id) ?? []),
      targetMatched: { actionsWithKnownSession: stat.targetMatchedActions,
        nativePoolEvents: [...stat.targetMatchedKeys].flatMap(id => nativeByRequest.get(id) ?? []),
        ...sampleTimings([...stat.targetMatchedKeys].map(id => linkedEntries.get(id)).filter(Boolean)) },
      endpoints: Object.fromEntries(stat.endpoints), ...sampleTimings([...stat.requestKeys].map(id => linkedEntries.get(id)).filter(Boolean)) })),
    longestBlocked: sortedByBlocked.map(details), longestTotal: sortedByTotal.map(details),
  };
}
const phases = cdp.groups.map(group => statistics(group.label, [group]));
const core = cdp.groups.filter(group => /^heavy-(terminal|files|browser)$/.test(group.label));
const summary = {
  origin: cdp.origin, timings: "milliseconds, nearest-rank percentiles", netlogFinalized: netLog?.finalized ?? null,
  nativePairingMethod: "Exact URL + HTTP method + matching start clocks (within 20 ms; reject ambiguous candidates). Phase-level native counts cover events even when no CDP pair was proven.",
  nativePairing,
  phaseResults: phases, combinedHeavy: core.length ? statistics("heavy-core", core) : null,
};
await writeFile(output, JSON.stringify(summary, null, 2) + "\n");
process.stdout.write(JSON.stringify([...phases, ...(summary.combinedHeavy ? [summary.combinedHeavy] : [])]
  .map(({ label, phases, durationSec, combinedTimings, peaks, nativePoolEvents, endpointQps }) =>
    ({ label, phases, durationSec, combinedTimings, cdpPeak: peaks.cdp?.n, netlogPeak: peaks.chromiumNetLog?.peakOpenStreams,
      nativePoolEvents, leadingRoutes: endpointQps.slice(0, 6).map(({ endpoint, qps }) => ({ endpoint, qps })) }))) + "\n");
