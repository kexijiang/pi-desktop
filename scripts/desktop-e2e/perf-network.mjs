import { writeFile } from "node:fs/promises";

const STREAM_MIME = "text/event-stream";
const privateQueryKey = /(?:^|[_-])(token|secret|password|key|authorization)(?:$|[_-])/i;
const assetPattern = /^(?:\/api\/|\/workspace\/)/;

// Match the timing decomposition used by Chromium DevTools RequestTimingView.
// "Stalled" can have causes besides socket exhaustion. NetLog keeps those distinct.
const isOffset = value => Number.isFinite(value) && value >= 0;
const round = value => Math.round(value * 1000) / 1000;
const elapsed = (start, end) => round(Math.max(0, (end - start) * 1000));

export function summarizePerfSamples(values) {
  const sorted = values.filter(Number.isFinite).sort((first, second) => first - second);
  const value = q => sorted.length ? round(sorted[Math.ceil(sorted.length * q) - 1]) : null;
  return { n: sorted.length, p50: value(.5), p95: value(.95), max: value(1) };
}

function sanitizedUrl(raw) {
  const url = new URL(raw);
  for (const key of url.searchParams.keys()) {
    if (privateQueryKey.test(key) || /^(?:accessToken|apiKey|authToken)$/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.href;
}

function mimeType(response) {
  const contentType = Object.entries(response.headers ?? {})
    .find(([key]) => key.toLowerCase() === "content-type")?.[1];
  return String(contentType ?? response.mimeType ?? "").split(";")[0].trim();
}

function endpointKey(request) {
  const { pathname } = new URL(request.url);
  return request.method + " " + pathname
    .replace(/\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?=\/|$)/gi, "/:id")
    .replace(/(\/api\/shell\/sessions\/)[^/]+/g, "$1:id");
}

function timingMetrics(record) {
  const { timing, started, headersCompleteAt, finishedAt } = record;
  const totalMs = finishedAt === undefined ? undefined : elapsed(started, finishedAt);
  const headerMs = headersCompleteAt === undefined ? undefined : elapsed(started, headersCompleteAt);
  if (!timing || !Number.isFinite(timing.requestTime) || !Number.isFinite(headersCompleteAt)) return { totalMs, headerMs };

  const queuedMs = elapsed(started, timing.requestTime);
  const elapsedUntilHeaders = elapsed(timing.requestTime, headersCompleteAt);
  const stalledMs = [
    ...(record.serviceWorker ? [timing.workerStart] : [timing.dnsStart, timing.connectStart, timing.sendStart]),
    elapsedUntilHeaders,
  ].find(isOffset) ?? 0;
  const sendEnd = isOffset(timing.sendEnd) ? timing.sendEnd : undefined;
  const responseHeaderStart = isOffset(timing.receiveHeadersStart)
    ? timing.receiveHeadersStart : elapsedUntilHeaders;
  return {
    queuedMs, stalledMs, blockedMs: round(queuedMs + stalledMs),
    afterSendToHeadersMs: sendEnd === undefined ? undefined : round(Math.max(0, responseHeaderStart - sendEnd)),
    totalMs, headerMs,
  };
}

function canBeStream(record) {
  return record.type === "EventSource" || record.mime === STREAM_MIME;
}

function streamWindow(requests, startedMs, endedMs) {
  const overlapping = requests.filter(request => {
    if (!canBeStream(request) || request.responseAt === undefined || request.status !== 200) return false;
    return Math.max(request.responseWallMs, startedMs) < Math.min(request.finishedWallMs ?? Infinity, endedMs);
  });
  const edges = overlapping.flatMap(request => [
    { atMs: Math.max(request.responseWallMs, startedMs), request, open: true },
    { atMs: Math.min(request.finishedWallMs ?? Infinity, endedMs), request, open: false },
  ]).sort((first, second) => first.atMs - second.atMs || Number(first.open) - Number(second.open));
  const open = new Map();
  const snapshots = [];
  for (let index = 0; index < edges.length; ) {
    const atMs = edges[index].atMs;
    while (edges[index]?.atMs === atMs) {
      const edge = edges[index++];
      if (edge.open) open.set(edge.request.id, edge.request);
      else open.delete(edge.request.id);
    }
    // Don't claim interval work at a window's right endpoint or for a zero-span request.
    const untilMs = edges[index]?.atMs ?? endedMs;
    if (atMs < untilMs) {
      snapshots.push({
        atMs: round(atMs), untilMs: round(untilMs),
        streams: [...open.values()].map(({ url, connectionId, protocol, id }) => ({ url, connectionId, protocol, id })),
      });
    }
  }
  const count = Math.max(0, ...snapshots.map(snapshot => snapshot.streams.length));
  return {
    peakOpenStreams: count,
    peakDistinctKnownConnections: Math.max(0, ...snapshots.map(snapshot =>
      new Set(snapshot.streams.map(stream => stream.connectionId).filter(id => id && id !== "0")).size)),
    peakSnapshot: snapshots.find(snapshot => snapshot.streams.length === count) ?? null,
    snapshots,
    streamRequests: overlapping.length,
    pendingOrFailedEventSourceStarts: requests.filter(request =>
      request.type === "EventSource" && request.startedWallMs >= startedMs && request.startedWallMs < endedMs
      && (request.responseAt === undefined || request.status !== 200)).map(({ id, url, error, status }) => ({ id, url, error, status })),
  };
}

function apiTable(requests, seconds) {
  const grouped = new Map();
  for (const request of requests) {
    const key = endpointKey(request);
    const current = grouped.get(key) ?? [];
    grouped.set(key, current);
    current.push(request);
  }
  return [...grouped.entries()].map(([endpoint, samples]) => ({
    endpoint,
    requests: samples.length,
    responses: samples.filter(request => request.responseAt !== undefined).length,
    completed: samples.filter(request => request.finishedAt !== undefined && !request.error).length,
    failed: samples.filter(request => request.error).length,
    qps: seconds > 0 ? round(samples.length / seconds) : null,
    queuedMs: summarizePerfSamples(samples.map(request => request.metrics.queuedMs)),
    stalledMs: summarizePerfSamples(samples.map(request => request.metrics.stalledMs)),
    blockedMs: summarizePerfSamples(samples.map(request => request.metrics.blockedMs)),
    headerMs: summarizePerfSamples(samples.map(request => request.metrics.headerMs)),
    afterSendToHeadersMs: summarizePerfSamples(samples.map(request => request.metrics.afterSendToHeadersMs)),
    totalMs: summarizePerfSamples(samples.filter(request => !request.error).map(request => request.metrics.totalMs)),
  })).sort((first, second) => second.requests - first.requests);
}

export async function attachPerfNetwork(page) {
  const origin = new URL(page.url()).origin;
  const records = [];
  const windows = [];
  const activeWindows = new Map();
  const markers = [];
  const operations = [];
  const cdps = new Map();
  const warnings = [];

  async function attach(candidate) {
    if (cdps.has(candidate)) return;
    const cdp = await candidate.context().newCDPSession(candidate);
    const target = cdps.size + 1;
    cdps.set(candidate, cdp);
    const live = new Map();
    function responseFor(request, { response, timestamp, type }) {
      request.status = response.status;
      request.responseAt = timestamp;
      const { requestTime, receiveHeadersEnd } = response.timing ?? {};
      request.headersCompleteAt = Number.isFinite(requestTime) && isOffset(receiveHeadersEnd)
        ? requestTime + receiveHeadersEnd / 1000 : timestamp;
      request.responseWallMs = request.startedWallMs + elapsed(request.started, request.headersCompleteAt);
      request.protocol = response.protocol;
      request.connectionId = response.connectionId;
      request.connectionReused = response.connectionReused;
      request.mime = mimeType(response);
      request.timing = response.timing;
      request.serviceWorker = response.fromServiceWorker;
      request.cached ||= response.fromDiskCache || response.fromPrefetchCache;
      if (type) request.type = type;
    }
    function finish(request, timestamp) {
      request.finishedAt = timestamp;
      request.finishedWallMs = request.startedWallMs + elapsed(request.started, timestamp);
    }
    cdp.on("Network.requestWillBeSent", event => {
      const { requestId, request, timestamp, wallTime, type, redirectResponse, initiator } = event;
      const previous = live.get(requestId);
      if (redirectResponse && previous) {
        responseFor(previous, { response: redirectResponse, timestamp });
        finish(previous, timestamp);
        live.delete(requestId);
      }
      if (!request.url.startsWith(origin + "/")) return;
      const url = sanitizedUrl(request.url);
      if (!assetPattern.test(new URL(url).pathname)) return;
      const entry = {
        id: target + ":" + requestId + ":" + records.length, target, requestId, url, type,
        method: request.method, started: timestamp, startedWallMs: wallTime * 1000,
        initiator: {
          type: initiator?.type,
          frames: initiator?.stack?.callFrames?.slice(0, 4).map(({ functionName, url, lineNumber, columnNumber }) =>
            ({ functionName, url: url.startsWith(origin + "/") ? sanitizedUrl(url) : "", lineNumber, columnNumber })),
        },
        cached: false,
      };
      live.set(requestId, entry);
      records.push(entry);
    });
    cdp.on("Network.responseReceived", event => {
      const request = live.get(event.requestId);
      if (request) responseFor(request, event);
    });
    cdp.on("Network.requestServedFromCache", event => {
      const request = live.get(event.requestId);
      if (request) request.cached = true;
    });
    cdp.on("Network.eventSourceMessageReceived", event => {
      const request = live.get(event.requestId);
      if (!request) return;
      request.firstEventAt ??= event.timestamp;
      request.lastEventAt = event.timestamp;
      request.eventCount = (request.eventCount ?? 0) + 1;
    });
    cdp.on("Network.loadingFinished", event => {
      const request = live.get(event.requestId);
      if (!request) return;
      finish(request, event.timestamp);
      request.encodedDataLength = event.encodedDataLength;
      live.delete(event.requestId);
    });
    cdp.on("Network.loadingFailed", event => {
      const request = live.get(event.requestId);
      if (!request) return;
      finish(request, event.timestamp);
      request.error = event.errorText;
      request.cancelled = event.canceled;
      live.delete(event.requestId);
    });
    await cdp.send("Network.enable");
  }

  await attach(page);
  const context = page.context();
  const handlePage = candidate => {
    void attach(candidate).catch(error => warnings.push("Additional CDP target unavailable: " + error.message));
  };
  context.on("page", handlePage);
  for (const candidate of context.pages()) {
    if (candidate !== page) await attach(candidate).catch(error => warnings.push("Additional CDP target unavailable: " + error.message));
  }

  function begin(label) {
    if (activeWindows.has(label)) throw new Error("Already recording network window " + label);
    activeWindows.set(label, Date.now());
  }
  function end(label) {
    const startMs = activeWindows.get(label);
    if (startMs === undefined) throw new Error("No network window " + label);
    activeWindows.delete(label);
    windows.push({ label, startMs, endMs: Date.now() });
  }
  function mark(label, details) {
    markers.push({ label, details, atMs: Date.now() });
  }
  function beginOperation(label, options = {}) {
    const operation = { label, startMs: Date.now(), ...options };
    operations.push(operation);
    return () => { operation.endMs = Date.now(); };
  }
  function activeStreams() {
    return records.filter(request =>
      canBeStream(request) && request.status === 200 && request.responseAt !== undefined && request.finishedAt === undefined)
      .map(({ id, url, protocol, connectionId, eventCount }) => ({ id, url, protocol, connectionId, eventCount }));
  }

  function collect() {
    const now = Date.now();
    const requests = records.map(request => ({ ...request, metrics: timingMetrics(request) }));
    const groups = [...windows, ...[...activeWindows.entries()].map(([label, startMs]) =>
      ({ label, startMs, endMs: now, unfinished: true }))].map(window => {
      const selected = requests.filter(request => request.startedWallMs >= window.startMs && request.startedWallMs < window.endMs);
      const ordinary = selected.filter(request => !canBeStream(request));
      const intervalSeconds = (window.endMs - window.startMs) / 1000;
      return {
        ...window,
        intervalSeconds,
        streaming: streamWindow(requests, window.startMs, window.endMs),
        ordinary: {
          issued: ordinary.length,
          unobservedTiming: ordinary.filter(request => request.metrics.blockedMs === undefined).length,
          httpVersions: [...new Set(ordinary.map(request => request.protocol).filter(Boolean))],
          queuedMs: summarizePerfSamples(ordinary.map(request => request.metrics.queuedMs)),
          stalledMs: summarizePerfSamples(ordinary.map(request => request.metrics.stalledMs)),
          blockedMs: summarizePerfSamples(ordinary.map(request => request.metrics.blockedMs)),
          headerMs: summarizePerfSamples(ordinary.map(request => request.metrics.headerMs)),
          afterSendToHeadersMs: summarizePerfSamples(ordinary.map(request => request.metrics.afterSendToHeadersMs)),
          totalMs: summarizePerfSamples(ordinary.filter(request => !request.error).map(request => request.metrics.totalMs)),
          endpointQps: apiTable(ordinary, intervalSeconds),
        },
        operations: operations.filter(operation => operation.startMs >= window.startMs && operation.startMs < window.endMs)
          .map(operation => {
            const matchEnd = operation.endMs ?? now;
            const matching = ordinary.filter(request => request.startedWallMs >= operation.startMs
              && request.startedWallMs <= matchEnd
              && (!operation.urlPattern || new RegExp(operation.urlPattern).test(request.url))
              && (!operation.method || operation.method === request.method));
            return { ...operation, matchIsTemporalOnly: !operation.urlPattern,
              requests: matching.map(request => ({
                id: request.id, url: request.url, method: request.method, status: request.status, ...request.metrics,
              })) };
          }),
      };
    });
    return {
      source: "Electron Chromium DevTools Protocol Network domain", origin, warnings,
      semantics: {
        windowsUseWallClock: true,
        timingDurationsUseMonotonicChromeTimestamps: true,
        queueing: "CDP issue time to network requestTime. Stalled is requestTime to first DNS/connect/send (DevTools definition). Sum is blocked, not a socket-only statistic.",
        streams: "2xx EventSource or text/event-stream responses active between headers and request completion. A request that has not received headers is tracked as pending, not an open stream.",
        ordinary: "Same-origin API/workspace requests exclusive of recognized response streams. Failed or censored requests stay in raw data; total latency aggregates completed results only.",
        qps: "Requests issued during window divided by window duration. Graph association by time and optional method/path filter is not in itself causal proof.",
      },
      groups, markers, requests,
    };
  }

  async function save(output) {
    const report = collect();
    await writeFile(output, JSON.stringify(report, null, 2));
    return report;
  }
  async function close() {
    context.off("page", handlePage);
    await Promise.allSettled([...cdps.values()].map(cdp => cdp.detach()));
  }

  return { begin, end, mark, beginOperation, activeStreams, addPage: attach, save, close };
}
