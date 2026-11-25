import { readFile, writeFile } from 'node:fs/promises';
import { stats } from './summarize-renderer.mjs';

const path = process.argv[2];
if (!path) throw new Error('Pass ui-evidence.json and optionally an output path');
const data = JSON.parse(await readFile(path, 'utf8'));
const minus = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? a - b : null;

function summarise(rows) {
  return {
    clickThroughVisibleMarkerMs: stats(rows.map(row => row.uiFirstBoundMs)),
    clickToMockRequestMs: stats(rows.map(row => minus(row.modelRequestAt, row.startAt))),
    mockRequestToFirstWriteMs: stats(rows.map(row => minus(row.fixtureFirstAt, row.modelRequestAt))),
    mockFirstWriteToObservedMarkerMs: stats(rows.map(row => minus(row.uiFirstAt, row.fixtureFirstAt))),
  };
}

const phases = Object.fromEntries(data.phases.map(phase => {
  const actions = data.actions.filter(row => row.phase === phase.phase);
  const phaseResponses = data.firstResponses.filter(row => row.phase === phase.phase);
  return [phase.phase, { phase,
    actions: Object.fromEntries([...Map.groupBy(actions, row => row.kind)].map(([name, rows]) => [name, {
      errors: rows.filter(row => row.error).length,
      commandThroughUiReceiptMs: stats(rows.filter(row => !row.error).map(row => row.receiptMs)),
    }])),
    firstResponses: summarise(phaseResponses),
  }];
}));
const pairDeltas = [];
const paired = [...Map.groupBy(data.firstResponses.filter(row => row.pair), row => row.pair)];
for (const [pair, rows] of paired) {
  const cold = rows.find(row => row.kind === 'cold');
  const warm = rows.find(row => row.kind === 'warm');
  if (cold && warm) pairDeltas.push({ pair, cold, warm,
    coldMinusWarmObservedFirstMs: cold.uiFirstBoundMs - warm.uiFirstBoundMs });
}
const stops = data.stability.filter(row => row.kind === 'stop');
const report = {
  basedOn: path, method: 'Nearest rank. Browser automation acknowledgement and 50 ms UI polling bracket, see renderer and network evidence for browser input timestamps.',
  phases, phaseErrors: data.phaseErrors, serverSamplingError: data.serverSamplingError,
  cold: summarise(data.firstResponses.filter(row => row.kind === 'cold')),
  warm: summarise(data.firstResponses.filter(row => row.kind === 'warm')),
  pairs: pairDeltas, coldMinusWarmObservedFirstMs: stats(pairDeltas.map(row => row.coldMinusWarmObservedFirstMs)),
  stopGroups: Object.fromEntries([...Map.groupBy(stops, row => row.phase)].map(([phase, rows]) => [phase, {
    uiMs: stats(rows.filter(row => !row.ui.timedOut).map(row => row.ui.sinceClickMs)),
    serverMs: stats(rows.filter(row => !row.service.timedOut).map(row => row.service.sinceClickMs)),
    observedUiMinusServerMs: stats(rows.filter(row => !row.ui.timedOut && !row.service.timedOut).map(row => row.uiVersusServiceMs)),
    uiTimeouts: rows.filter(row => row.ui.timedOut).length, serverTimeouts: rows.filter(row => row.service.timedOut).length,
  }])),
  stability: data.stability,
};
const rendered = JSON.stringify(report, null, 2) + '\n';
if (process.argv[3]) await writeFile(process.argv[3], rendered);
else process.stdout.write(rendered);
