// Loaded by the outer launcher of an extracted diagnostic copy only.
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const directory = process.env.PIORA_PERF_SERVER_DIR;
if (!directory) throw new Error("Packaged probe requires an isolated sample directory");
const attachLate = process.env.PIORA_PERF_PACKAGE_ATTACH_LATE === "1";
const activation = join(directory, "activate-probe");
if (attachLate && !existsSync(activation)) {
  const timer = setInterval(() => {
    if (!existsSync(activation)) return;
    clearInterval(timer);
    delete require.cache[__filename];
    require(__filename);
  }, 150).unref();
  return;
}
const { AsyncLocalStorage } = require("node:async_hooks");
const { subscribe } = require("node:diagnostics_channel");
const { createWriteStream, mkdirSync, watch } = require("node:fs");
const { readFile, readdir, unlink, writeFile } = require("node:fs/promises");
const { Session } = require("node:inspector");
const Module = require("node:module");
const { availableParallelism } = require("node:os");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

mkdirSync(directory, { recursive: true });
const commandDirectory = join(directory, "control");
mkdirSync(commandDirectory, { recursive: true });
const stream = createWriteStream(join(directory, "server-" + process.pid + ".jsonl"), { flags: "a" });
stream.on("error", console.error);
const resolutionMs = 5;
let phase;
let requestNumber = 0;
const chatStreams = new Map();
const requestScope = new AsyncLocalStorage();
const packageResolutionCache = new Map();
let variant = "full";

function record(type, fields = {}) {
  stream.write(JSON.stringify({ type, at: Date.now(), monoMs: performance.now(), pid: process.pid, phase: phase?.name, ...fields }) + "\n");
}

function snapshot() {
  return { at: Date.now(), t: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage(), utilization: performance.eventLoopUtilization() };
}

function changes(start, end) {
  const durationMs = end.t - start.t;
  const cpuMs = (end.cpu.user + end.cpu.system - start.cpu.user - start.cpu.system) / 1000;
  return { durationMs, cpuMs, cpuOneCorePct: cpuMs / durationMs * 100, utilization: performance.eventLoopUtilization(end.utilization, start.utilization).utilization,
    rssBytes: end.memory.rss, heapUsedBytes: end.memory.heapUsed, heapTotalBytes: end.memory.heapTotal,
    rssDeltaBytes: end.memory.rss - start.memory.rss, heapUsedDeltaBytes: end.memory.heapUsed - start.memory.heapUsed };
}

function histogramResult(histogram) {
  const ms = ns => ns / 1e6;
  return { n: histogram.count, p50: ms(histogram.percentile(50)), p95: ms(histogram.percentile(95)), p99: ms(histogram.percentile(99)), max: ms(histogram.max) };
}

function inspectorCall(inspector, method) {
  return new Promise((resolve, reject) => inspector.post(method, (error, result) => error ? reject(error) : resolve(result)));
}

async function control(command) {
  const name = command.phase;
  if (command.action === "status") return { pid: process.pid, phase: phase?.name, node: process.version, electron: process.versions.electron };
  if (command.action === "variant") {
    if (!phase?.sdkSpans || !["full", "omit-heavy", "cache-resolve"].includes(command.variant)) throw new Error("SDK experiment mode is required");
    variant = command.variant;
    record("sdk-experiment-variant", { variant });
    return { variant };
  }
  if (command.action === "disconnect") {
    if (!phase || !/^[a-f0-9-]{36}$/i.test(command.sessionId ?? "")) throw new Error("A running phase and synthetic session id are required");
    const sockets = [...(chatStreams.get(command.sessionId) ?? [])];
    for (const response of sockets) response.destroy();
    record("stream-disconnect", { sessionId: command.sessionId, closed: sockets.length });
    return { closed: sockets.length };
  }
  if (!/^[a-z0-9-]{1,64}$/i.test(name ?? "")) throw new Error("Invalid phase");
  if (command.action === "start") {
    if (phase) throw new Error("Already sampling " + phase.name);
    let profiler;
    if (command.profile) {
      profiler = new Session();
      profiler.connect();
      await inspectorCall(profiler, "Profiler.enable");
      await inspectorCall(profiler, "Profiler.start");
    }
    const total = monitorEventLoopDelay({ resolution: resolutionMs });
    const interval = monitorEventLoopDelay({ resolution: resolutionMs });
    total.enable();
    interval.enable();
    const start = snapshot();
    let last = start;
    const timer = setInterval(() => {
      const current = snapshot();
      record("interval", { ...changes(last, current), eventLoopMs: histogramResult(interval) });
      interval.reset();
      last = current;
    }, 1000).unref();
    variant = "full";
    packageResolutionCache.clear();
    phase = { name, start, total, interval, timer, profiler, sdkSpans: command.sdkSpans === true };
    record("phase-start", { resolutionMs, parallelism: availableParallelism(), start, profile: Boolean(profiler), sdkSpans: phase.sdkSpans });
    return { pid: process.pid, phase: name };
  }
  if (command.action === "stop") {
    if (phase?.name !== name) throw new Error("Active phase is " + (phase?.name ?? "none"));
    const current = phase;
    const end = snapshot();
    current.total.disable();
    current.interval.disable();
    clearInterval(current.timer);
    const result = { phase: name, start: current.start, end, pid: process.pid, resolutionMs, parallelism: availableParallelism(),
      ...changes(current.start, end), eventLoopMs: histogramResult(current.total) };
    record("phase-stop", result);
    phase = undefined;
    if (current.profiler) {
      const result = await inspectorCall(current.profiler, "Profiler.stop");
      current.profiler.disconnect();
      await writeFile(join(directory, "server-" + name + "-" + process.pid + ".cpuprofile"), JSON.stringify(result.profile));
    }
    return result;
  }
  throw new Error("Unknown sampler command");
}

let serial = Promise.resolve();
const jobs = new Set();
function watchCommand(filename) {
  if (!filename || !/^cmd-[a-f0-9-]{36}\.json$/i.test(filename) || jobs.has(filename)) return;
  jobs.add(filename);
  serial = serial.then(async () => {
    const file = join(commandDirectory, filename);
    const ack = join(commandDirectory, filename.replace(/^cmd-/, "ack-"));
    let command;
    try { command = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    let result;
    try { result = await control(command); }
    catch (error) { result = { error: String(error) }; }
    await writeFile(ack, JSON.stringify(result));
    await unlink(file);
  }).catch(error => record("control-error", { error: String(error) })).finally(() => jobs.delete(filename));
}
watch(commandDirectory, { persistent: false }, (_event, filename) => watchCommand(filename));
void readdir(commandDirectory).then(files => files.forEach(watchCommand), error => record("control-error", { error: String(error) }));

// Record server request receipt, response completion and the time of the first
// session event; no credentials or request/response body are persisted.
subscribe("http.server.request.start", ({ request, response }) => {
  if (!request.url?.startsWith("/api/")) return;
  const url = new URL(request.url, "http://127.0.0.1");
  const sessionId = /^\/api\/agent\/([a-f0-9-]{36})(?:\/|$)/i.exec(url.pathname)?.[1];
  const isChatStream = sessionId && url.pathname.endsWith("/events") && !url.searchParams.has("scope");
  if (isChatStream) {
    const sockets = chatStreams.get(sessionId) ?? new Set();
    sockets.add(response);
    chatStreams.set(sessionId, sockets);
    response.once("close", () => { sockets.delete(response); if (!sockets.size) chatStreams.delete(sessionId); });
  }
  if (!phase) return;
  const start = performance.now(), window = phase.name;
  const requestId = ++requestNumber;
  const fields = { phase: window, requestId, path: url.pathname, method: request.method, sessionId };
  if (phase.sdkSpans) requestScope.enterWith(fields);
  record("http-received", fields);
  const finish = (type) => record(type, { ...fields, status: response.statusCode, contentType: response.getHeader("content-type"), ms: performance.now() - start });
  response.once("finish", () => finish("http-finished"));
  response.once("close", () => { if (!response.writableFinished) finish("http-closed"); });
  if (!isChatStream) return;
  const write = response.write;
  let connected = false, firstText = false;
  response.write = function (chunk, ...args) {
    if (!firstText && (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
      for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (!connected && event.type === "connected") {
          connected = true;
          record("route-sse-connected", { phase: window, sessionId, requestId, ms: performance.now() - start });
        }
        if ((event.type === "message_delta" && event.field === "text" && event.delta)
          || (event.type === "message_block" && event.block?.type === "text" && event.block.text)
          || (event.message?.role === "assistant" && event.message.content?.some(block => block.type === "text" && block.text))) {
          firstText = true;
          record("route-sse-first-text", { phase: window, sessionId, requestId, ms: performance.now() - start });
        }
      }
    }
    return Reflect.apply(write, this, [chunk, ...args]);
  };
});

if (process.env.PIORA_PERF_PACKAGE_SDK_SPANS === "1") {
  const decorated = new WeakMap();
  function timed(target, name, type) {
    const original = target?.[name];
    if (typeof original !== "function") return;
    const timedFn = function (...args) {
      if (!phase?.sdkSpans) return Reflect.apply(original, this, args);
      const start = performance.now(), window = phase.name;
      const stack = new Error().stack?.split("\n").slice(2, 6);
      const rowFields = { ...requestScope.getStore(), phase: window, variant };
      const finish = () => record(type, { ...rowFields, ms: performance.now() - start, stack });
      if (name === "createAgentSessionServices" && Array.isArray(args[0]?.resourceLoaderOptions?.additionalExtensionPaths)) {
        const paths = args[0].resourceLoaderOptions.additionalExtensionPaths;
        rowFields.configuredExtensions = paths.length;
        if (variant === "omit-heavy") {
          const remaining = paths.filter(path => !/[\\/]piora-(browser|harmony|room|meme)\.[cm]?[jt]s$/i.test(path));
          rowFields.configuredExtensions = remaining.length;
          args[0] = { ...args[0], resourceLoaderOptions: { ...args[0].resourceLoaderOptions, additionalExtensionPaths: remaining } };
        }
      }
      const cacheKey = variant === "cache-resolve" && name === "resolve" && typeof this?.cwd === "string" && args.length < 2 && args[0] === undefined
        ? this.cwd + "|" + (this.agentDir ?? "") : undefined;
      if (cacheKey && packageResolutionCache.has(cacheKey)) {
        rowFields.cacheHit = true;
        const value = structuredClone(packageResolutionCache.get(cacheKey));
        finish();
        return Promise.resolve(value);
      }
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { finish(); throw error; }
      if (result && typeof result.then === "function") return result.then(value => {
        if (cacheKey) packageResolutionCache.set(cacheKey, structuredClone(value));
        finish();
        return value;
      }, error => { finish(); throw error; });
      finish();
      return result;
    };
    return timedFn;
  }
  function decorate(result) {
    if (decorated.has(result)) return decorated.get(result);
    const descriptors = Object.getOwnPropertyDescriptors(result);
    const applied = [];
    for (const [name, type] of [
      ["createAgentSessionServices", "session-services"], ["createAgentSessionFromServices", "session-from-services"],
      ["resolveModelScopeWithDiagnostics", "sdk-model-scope"],
    ]) {
      const fn = timed(result, name, type);
      if (fn) { descriptors[name] = { value: fn, enumerable: true }; applied.push(name); }
    }
    for (const [target, name, type] of [
      [result.SessionManager, "open", "session-manager-open"], [result.SessionManager, "create", "session-manager-create"],
      [result.SettingsManager, "create", "settings-manager"], [result.DefaultPackageManager?.prototype, "resolve", "sdk-package-manager-resolve"],
      [result.AgentSession?.prototype, "bindExtensions", "extension-bind"],
      [result.ModelRegistry?.prototype, "getAvailable", "sdk-visible-models"],
    ]) {
      const fn = timed(target, name, type);
      if (fn) {
        try { target[name] = fn; applied.push(name); }
        catch (error) { record("sdk-instrumentation-skipped", { name, error: String(error) }); }
      }
    }
    const exports = Object.create(Object.getPrototypeOf(result), descriptors);
    decorated.set(result, exports);
    record("sdk-instrumentation-installed", { methods: applied });
    return exports;
  }

  if (typeof Module.registerHooks === "function") {
    const key = Symbol.for("piora.packaged.perf.sdk");
    globalThis[key] = { timed };
    const prototypes = {
      "agent-session.js": [["AgentSession.prototype", "bindExtensions", "extension-bind"]],
      "session-manager.js": [["SessionManager", "open", "session-manager-open"], ["SessionManager", "create", "session-manager-create"]],
      "settings-manager.js": [["SettingsManager", "create", "settings-manager"]],
      "package-manager.js": [["DefaultPackageManager.prototype", "resolve", "sdk-package-manager-resolve"]],
      "model-registry.js": [["ModelRegistry.prototype", "getAvailable", "sdk-visible-models"]],
    };
    const functions = {
      "agent-session-services.js": [["createAgentSessionServices", "session-services"], ["createAgentSessionFromServices", "session-from-services"]],
      "model-resolver.js": [["resolveModelScopeWithDiagnostics", "sdk-model-scope"]],
    };
    Module.registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        const match = /\/@earendil-works\/pi-coding-agent\/dist\/core\/([^/]+\.js)$/.exec(url.replaceAll("\\", "/"));
        if (!match || typeof result.source !== "string" && !(result.source instanceof Uint8Array)) return result;
        const file = match[1];
        if (!functions[file] && !prototypes[file]) return result;
        let source = Buffer.isBuffer(result.source) || result.source instanceof Uint8Array ? Buffer.from(result.source).toString("utf8") : result.source;
        const instrumented = [];
        const api = 'globalThis[Symbol.for("piora.packaged.perf.sdk")]';
        for (const [name, type] of functions[file] ?? []) {
          const signature = "export async function " + name + "(";
          if (!source.includes(signature)) continue;
          source = source.replace(signature, "async function __pioraPerf_" + name + "(");
          source += "\nexport const " + name + " = " + api + ".timed({" + name + ": __pioraPerf_" + name + "}, " + JSON.stringify(name) + ", " + JSON.stringify(type) + ");\n";
          instrumented.push(name);
        }
        for (const [target, name, type] of prototypes[file] ?? []) {
          const className = target.split(".")[0];
          if (!source.includes("export class " + className)) continue;
          source += "\nif (typeof " + target + "." + name + ' === "function") ' + target + "." + name + " = " + api + ".timed(" + target + ", " + JSON.stringify(name) + ", " + JSON.stringify(type) + ");\n";
          instrumented.push(className + "." + name);
        }
        if (instrumented.length) record("sdk-load-hook", { file, instrumented });
        return { ...result, source };
      },
    });
  } else {
    const load = Module._load;
    Module._load = function (id, parent, main) {
      const result = Reflect.apply(load, this, [id, parent, main]);
      if ((id === "@earendil-works/pi-coding-agent" || /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]index\.js$/.test(id))
        && result && (typeof result === "object" || typeof result === "function")) return decorate(result);
      return result;
    };
  }
}

record("server-attached", { execPath: process.execPath, node: process.version, electron: process.versions.electron, attachLate, sdkSpans: process.env.PIORA_PERF_PACKAGE_SDK_SPANS === "1" });
