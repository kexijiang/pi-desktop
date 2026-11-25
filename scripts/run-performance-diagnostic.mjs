import { resolve } from 'node:path';
import { runDesktopScenario } from './desktop-e2e/harness.mjs';
import { performanceDiagnostic } from './desktop-e2e/scenarios/performance-diagnostic.mjs';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => controller.abort(new Error(signal)));
}
const executableFlag = process.argv.indexOf('--executable');
const executable = executableFlag < 0 ? undefined : resolve(process.argv[executableFlag + 1]);
const result = await runDesktopScenario({
  root: resolve(import.meta.dirname, '..'),
  scenario: performanceDiagnostic,
  signal: controller.signal,
  timeoutMs: 1_200_000,
  stepTimeoutMs: 180_000,
  electronDist: process.env.PIORA_PERF_ELECTRON_DIST,
  executable,
});
console.log(JSON.stringify({
  directory: result.directory, origin: result.report.origin, status: result.report.status,
  failedStep: result.report.failedStep, error: result.report.error, cleanupErrors: result.report.cleanupErrors,
}));
process.exitCode = result.report.status === 'passed' ? 0 : 1;
