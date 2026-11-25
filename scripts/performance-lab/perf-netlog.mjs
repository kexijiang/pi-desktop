import { readFile, writeFile } from "node:fs/promises";
import { summarizePerfSamples } from "../desktop-e2e/perf-network.mjs";

const [captureFile, cdpFile, output] = process.argv.slice(2);
if (!captureFile || !cdpFile || !output) throw new Error("Usage: node perf-netlog.mjs netlog.raw.json cdp-network.json netlog-evidence.json");

async function readNetLog(path) {
  const text = await readFile(path, "utf8");
  try { return { log: JSON.parse(text), finalized: true }; }
  catch (error) {
    const eventsStart = /"events"\s*:\s*\[\r?\n/.exec(text);
    if (!eventsStart) throw error;
    const header = text.slice(0, eventsStart.index) + '"events":[]}';
    const log = JSON.parse(header);
    const lines = text.slice(eventsStart.index + eventsStart[0].length).split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try { log.events.push(JSON.parse(line.replace(/,$/, ""))); }
      catch { /* Force shutdown can leave one partial event at EOF. */ }
    }
    if (!log.events.length) throw error;
    return { log, finalized: false };
  }
}

const { log, finalized } = await readNetLog(captureFile);
const cdp = JSON.parse(await readFile(cdpFile, "utf8"));
const { origin } = cdp;
const isOriginGroup = group => group === origin || group?.startsWith(origin + " ");
const isWebSocketJob = events => events.some(event => event.name === "HTTP_STREAM_JOB"
  && /^wss?:/.test(event.params?.logical_destination ?? ""));
const eventNames = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, type]) => [type, name]));
const wallOffset = Number(log.constants.timeTickOffset);
const beginPhase = log.constants.logEventPhase.PHASE_BEGIN;
const sourceEvents = new Map();
const requestControllers = new Map();
const jobsToRequests = new Map();
const directStalls = [];
for (const [order, record] of log.events.entries()) {
  const event = { ...record, name: eventNames[record.type], tick: Number(record.time), order };
  const sourceId = event.source.id;
  const events = sourceEvents.get(sourceId) ?? [];
  events.push(event);
  sourceEvents.set(sourceId, events);
  const dependency = event.params?.source_dependency?.id;
  if (event.name === "HTTP_STREAM_JOB_CONTROLLER_BOUND" && dependency) requestControllers.set(dependency, sourceId);
  if (event.name === "HTTP_STREAM_JOB_BOUND_TO_REQUEST" && dependency) jobsToRequests.set(sourceId, dependency);
  if (event.name === "HTTP_STREAM_REQUEST_BOUND_TO_JOB" && dependency) jobsToRequests.set(dependency, sourceId);
  if (event.name === "SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP" || event.name === "SOCKET_POOL_STALLED_MAX_SOCKETS") {
    directStalls.push(event);
  }
}

function sanitizedUrl(raw) {
  const url = new URL(raw);
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|key|authorization/i.test(key)) url.searchParams.set(key, "[redacted]");
  }
  return url.href;
}

const stallEvidence = directStalls.map(stall => {
  const socketJobId = stall.source.id;
  const jobEvents = sourceEvents.get(socketJobId) ?? [];
  const webSocketPool = isWebSocketJob(jobEvents);
  const controller = jobEvents.find(event => event.name === "HTTP_STREAM_JOB" && event.params?.source_dependency)?.params.source_dependency.id;
  const requestId = jobsToRequests.get(socketJobId) ?? requestControllers.get(controller);
  const events = sourceEvents.get(requestId) ?? [];
  const request = events.filter(event =>
    event.name === "URL_REQUEST_START_JOB" && event.phase === beginPhase && event.tick <= stall.tick && event.params?.url).at(-1);
  const group = jobEvents.filter(event =>
    event.name === "TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKET" && event.tick <= stall.tick && event.params?.group_id).at(-1);
  const socketBound = jobEvents.find(event => event.name === "SOCKET_POOL_BOUND_TO_SOCKET" && event.tick >= stall.tick);
  const sent = events.find(event => event.name === "HTTP_TRANSACTION_SEND_REQUEST" && event.phase === beginPhase && event.tick >= stall.tick);
  const isOrigin = request?.params.url.startsWith(origin + "/")
    || isOriginGroup(group?.params.group_id)
    || jobEvents.some(event => event.name === "HTTP_STREAM_JOB" && event.params?.destination === origin);
  return {
    event: stall.name, wallMs: wallOffset + stall.tick, socketJobId, requestId,
    url: request?.params.url.startsWith(origin + "/") ? sanitizedUrl(request.params.url) : undefined,
    method: request?.params.method,
    group: isOrigin ? group?.params.group_id : undefined,
    isOrigin: Boolean(isOrigin), webSocketPool,
    requestStartTick: request?.tick, stallTick: stall.tick, stallOrder: stall.order,
    socketBoundTick: socketBound?.tick, requestSentTick: sent?.tick,
    untilSocketBoundMs: socketBound ? socketBound.tick - stall.tick : undefined,
  };
});

const originStalls = stallEvidence.filter(event => event.isOrigin && !event.webSocketPool);
const originStreams = [...sourceEvents.entries()].flatMap(([source, events]) => {
  const opening = events.find(event => event.name === "HTTP_TRANSACTION_READ_RESPONSE_HEADERS"
    && event.params?.headers?.some(header => /^content-type:\s*text\/event-stream(?:\s*;|\s*$)/i.test(header)));
  if (!opening) return [];
  const request = events.filter(event => event.name === "URL_REQUEST_START_JOB" && event.phase === beginPhase
    && event.tick <= opening.tick && event.params?.url).at(-1);
  if (!request?.params.url.startsWith(origin + "/")) return [];
  const statusLine = opening.params.headers.find(header => /^HTTP\//.test(header));
  const [protocol, status] = String(statusLine ?? "").split(" ");
  if (status !== "200") return [];
  const binding = events.find(event => event.name === "HTTP_STREAM_REQUEST_BOUND_TO_JOB"
    && event.tick <= opening.tick && event.params?.source_dependency?.id);
  const job = binding?.params.source_dependency.id;
  const socket = (sourceEvents.get(job) ?? []).find(event => event.name === "SOCKET_POOL_BOUND_TO_SOCKET")?.params?.source_dependency?.id;
  const close = events.find(event => event.name === "REQUEST_ALIVE" && event.phase === log.constants.logEventPhase.PHASE_END
    && event.tick >= opening.tick);
  return [{ source, job, socket, url: sanitizedUrl(request.params.url), protocol,
    openedMs: wallOffset + opening.tick, closedMs: close ? wallOffset + close.tick : undefined }];
});

const streamById = new Map(originStreams.map(stream => [stream.source, stream]));
const socketLeases = [];
const endPhase = log.constants.logEventPhase.PHASE_END;
function keepLease(socket, start, end) {
  const job = start.params?.source_dependency?.id;
  const events = sourceEvents.get(job) ?? [];
  if (isWebSocketJob(events)) return;
  const group = events.find(item => item.name === "TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKET")?.params?.group_id;
  if (!isOriginGroup(group)) return;
  const requestId = jobsToRequests.get(job);
  const request = (sourceEvents.get(requestId) ?? []).find(item => item.name === "URL_REQUEST_START_JOB" && item.params?.url);
  const stream = streamById.get(requestId);
  socketLeases.push({ socket, job, group, requestId, url: request?.params.url.startsWith(origin + "/") ? sanitizedUrl(request.params.url) : undefined,
    sseOpenedMs: stream?.openedMs, startTick: start.tick, startOrder: start.order,
    endTick: end?.tick ?? Infinity, endOrder: end?.order ?? Infinity });
}
for (const [socket, events] of sourceEvents) {
  let start;
  for (const event of events) {
    if (event.name !== "SOCKET_IN_USE") continue;
    if (event.phase === beginPhase) {
      if (start) keepLease(socket, start, event);
      start = event;
    }
    else if (event.phase === endPhase && start) {
      keepLease(socket, start, event);
      start = undefined;
    }
  }
  if (start) keepLease(socket, start, null);
}

function atOrBefore(t1, order1, t2, order2) {
  return t1 < t2 || (t1 === t2 && order1 <= order2);
}
for (const stall of originStalls) {
  const candidates = socketLeases.filter(lease => lease.group === stall.group
    && atOrBefore(lease.startTick, lease.startOrder, stall.stallTick, stall.stallOrder)
    && !atOrBefore(lease.endTick, lease.endOrder, stall.stallTick, stall.stallOrder));
  stall.groupSocketOccupancy = candidates.map(({ socket, url, job, sseOpenedMs }) =>
    ({ socket, url, job, streamingSse: sseOpenedMs !== undefined && sseOpenedMs <= stall.wallMs }));
}

function peakStreams(window, streams) {
  const candidates = streams.filter(stream => stream.openedMs < window.endMs && (stream.closedMs ?? Infinity) > window.startMs);
  const sampleTimes = [window.startMs, ...candidates.map(stream => stream.openedMs).filter(atMs => atMs > window.startMs)]
    .sort((first, second) => first - second);
  let peak = { atMs: window.startMs, streams: [] };
  for (const atMs of sampleTimes) {
    const open = candidates.filter(stream => stream.openedMs <= atMs && (stream.closedMs ?? Infinity) > atMs);
    if (open.length > peak.streams.length) peak = { atMs, streams: open };
  }
  return { peakOpenStreams: peak.streams.length, peak, intersectingStreams: candidates.length };
}

const measurements = cdp.groups.map(window => {
  const samples = originStalls.filter(event => event.wallMs >= window.startMs && event.wallMs < window.endMs);
  return {
    label: window.label, startMs: window.startMs, endMs: window.endMs,
    perOriginGroupStallEvents: samples.filter(item => item.event === "SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP").length,
    globalSocketPoolStallEvents: samples.filter(item => item.event === "SOCKET_POOL_STALLED_MAX_SOCKETS").length,
    directlyMappedToRequest: samples.filter(item => item.url).length,
    untilSocketBoundMs: summarizePerfSamples(samples.map(item => item.untilSocketBoundMs)),
    streaming: peakStreams(window, originStreams),
    samples,
  };
});

const evidence = {
  source: "Chromium NetLog DEFAULT capture mode",
  captureFile, finalized, origin, eventCount: log.events.length, timeTickOffsetMs: wallOffset,
  chromium: {
    name: log.constants.clientInfo?.name, version: log.constants.clientInfo?.version,
    containsPerGroupEvent: Object.hasOwn(log.constants.logEventTypes, "SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP"),
    containsGlobalPoolEvent: Object.hasOwn(log.constants.logEventTypes, "SOCKET_POOL_STALLED_MAX_SOCKETS"),
  },
  findings: {
    originStallEvents: originStalls.length,
    originWebSocketStallEvents: stallEvidence.filter(event => event.isOrigin && event.webSocketPool).length,
    otherOrUnmappedStallEvents: stallEvidence.filter(event => !event.isOrigin).length,
    measurements,
    originStalls,
    originStreams,
  },
};
await writeFile(output, JSON.stringify(evidence, null, 2));
process.stdout.write(JSON.stringify({ finalized, chromium: evidence.chromium, origin, originStalls: originStalls.length,
  measurements: measurements.map(({ samples, ...rest }) => rest) }) + "\n");
