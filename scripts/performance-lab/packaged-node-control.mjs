import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function controlPackagedServer(directory, body, timeoutMs = 25_000) {
  const control = join(directory, "control");
  const id = randomUUID(), temporary = join(control, id + ".tmp"), cmd = join(control, "cmd-" + id + ".json"), ack = join(control, "ack-" + id + ".json");
  await mkdir(control, { recursive: true });
  await writeFile(join(directory, "activate-probe"), "fixture controller attached\n", { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await writeFile(temporary, JSON.stringify(body), { flag: "wx" });
  await rename(temporary, cmd);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    let result;
    try { result = JSON.parse(await readFile(ack, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (result) {
      await unlink(ack).catch(() => {});
      if (result.error) throw new Error(result.error);
      return result;
    }
    await delay(45);
  }
  throw new Error("No sampler acknowledgement within " + timeoutMs + " ms for " + JSON.stringify(body));
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}

export async function preparePackagedNodeProbe(extractedRoot) {
  const root = resolve(extractedRoot);
  const probe = join(dirname(fileURLToPath(import.meta.url)), "packaged-node-probe.cjs");
  const launcher = join(root, "resources", "web", "server.js");
  const ownMarker = join(root, ".piora-perf-owned");
  const backup = launcher + ".piora-perf-original";
  if (!(await stat(ownMarker).then(value => value.isFile(), () => false))) throw new Error("Expected an extracted copy marked with " + ownMarker);
  const original = await readFile(launcher, "utf8");
  if (!original.includes("runtime.asar") || original.includes("packaged-node-probe.cjs")) throw new Error("Launcher already patched or unexpected build layout");
  await writeFile(backup, original, { flag: "wx" });
  const loading = "if(process.env.PIORA_PERF_SERVER_DIR) require(" + JSON.stringify(probe) + ");\n";
  const strict = original.match(/^(['"]use strict\1;[^\S\r\n]*[\r\n]+)?/)?.[0] ?? "";
  await writeFile(launcher, strict + loading + original.slice(strict.length));
  return { launcher, backup, originalSha256: await sha256(backup), diagnosticSha256: await sha256(launcher) };
}
