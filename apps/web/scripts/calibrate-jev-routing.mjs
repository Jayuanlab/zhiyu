import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { routingMetrics } from './lib/jev-routing-metrics.mjs';
const inputPath = process.argv[2];
if (!inputPath) throw Error('Provide a results.json path');
const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const train = rows.filter(r => r.split === 'calibration');
if (train.length < 20) throw Error('At least 20 calibration cases required');
const decide = (row, select, exclude) => {
  const p = row.result.sourceProbabilities;
  if (!p) return row;
  const entries = Object.entries(p);
  const sources = entries.filter(([, p]) => p >= select).map(([s]) => s);
  const uncertain = entries.some(([, p]) => p > exclude && p < select);
  return { ...row, result: { ...row.result, status: uncertain ? 'degraded' : 'ok', sources } };
};
const candidates = [];
for (const select of [0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) for (const exclude of [0.1, 0.2, 0.3, 0.4]) {
  const metrics = routingMetrics(train.map(r => decide(r, select, exclude)));
  candidates.push({ select, exclude, metrics });
}
// Predeclared selection rule. No holdout row is examined before this selection is written.
const viable = candidates.filter(c => c.metrics.acceptedExactAccuracy === 1 && c.metrics.accepted >= 12);
viable.sort((a, b) => b.metrics.accepted - a.metrics.accepted || b.select - a.select || a.exclude - b.exclude);
const selected = viable[0] ?? { select: 0.8, exclude: 0.2, metrics: routingMetrics(train.map(r => decide(r, 0.8, 0.2))) };
const out = path.dirname(inputPath);
const selection = { labelOrigin: 'Agent-authored synthetic questions, predeclared labels; not human-verified production data',
  calibrationHash: createHash('sha256').update(JSON.stringify(train)).digest('hex'),
  rule: 'Zero accepted set errors and at least 12/24 accepted; maximize acceptance, then higher select and lower exclude',
  thresholds: { select: selected.select, exclude: selected.exclude }, foundViable: viable.length > 0, candidates };
fs.writeFileSync(path.join(out, 'calibration-selection.json'), JSON.stringify(selection, null, 2), 'utf8');
const holdout = rows.filter(r => r.split === 'heldout');
if (holdout.length < 20 || holdout.some(r => train.some(t => t.question === r.question))) throw Error('Missing or overlapping holdout');
const metrics = routingMetrics(holdout.map(r => decide(r, selected.select, selected.exclude)));
const baseline = routingMetrics(holdout.map(r => decide(r, 0.8, 0.2)));
const passesPilotGate = viable.length > 0 && metrics.accepted >= 10 && metrics.acceptedExactAccuracy >= 0.95
  && metrics.accepted >= baseline.accepted;
const report = { thresholds: selection.thresholds, passesPilotGate, metrics, baseline,
  holdoutHash: createHash('sha256').update(JSON.stringify(holdout)).digest('hex'),
  limitation: 'Small synthetic holdout only; no estimate of general production accuracy. Failed validation never changes runtime policy.' };
fs.writeFileSync(path.join(out, 'heldout-validation.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ thresholds: report.thresholds, passesPilotGate, accepted: metrics.accepted, accuracy: metrics.acceptedExactAccuracy, baselineAccepted: baseline.accepted }));
