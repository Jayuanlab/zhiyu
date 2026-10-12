import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Synthetic, public input only. Never emit credentials, provider text, or raw errors.
const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
let localEnvLoaded = false;
try { process.loadEnvFile(envPath); localEnvLoaded = true; } catch {}
const routerPath = fileURLToPath(new URL('../lib/brain/jev-recall-router.ts', import.meta.url));
const routerSource = readFileSync(routerPath, 'utf8');
const criteriaBlock = routerSource.match(/const criteria:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1];
if (!criteriaBlock) throw new Error('criteria_not_found');
const criteria = Object.fromEntries([...criteriaBlock.matchAll(/^\s*(architecture|records|knowledge|brain):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)].map(match => [match[1], JSON.parse(match[2])]));
if (Object.keys(criteria).length !== 4) throw new Error('criteria_count_mismatch');
const question = 'How is the public example software project organized into modules?';
const body = JSON.stringify({ model: 'jev-1.13.0', state: { question }, questions: Object.fromEntries(Object.entries(criteria).map(([source, instructions]) => [source, { type: 'noul', instructions }])) });
const evidence = {
  observedAt: new Date().toISOString(),
  configScope: 'diagnostic process loaded local env; not proof of production process loaded env',
  localEnvLoaded,
  keyPresent: Boolean(process.env.TYPESAFE_API_KEY),
  routingSetting: process.env.BRAIN_JEV_ROUTING === 'replace' ? 'replace' : process.env.BRAIN_JEV_ROUTING ? 'other' : 'missing',
  model: 'jev-1.13.0', endpoint: 'https://api.typesafe.ai/v1/systemone',
  questionKind: 'public_synthetic_question', questionHash: createHash('sha256').update(question).digest('hex'),
  payloadBytes: Buffer.byteLength(body), criteriaCount: Object.keys(criteria).length,
  observations: [],
};
if (evidence.keyPresent) {
  for (const deadlineMs of [2000, 8000]) {
    const started = performance.now();
    const observation = { deadlineMs, ok: false };
    try {
      const response = await fetch(evidence.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(deadlineMs),
      });
      observation.httpStatus = response.status;
      if (response.ok) {
        let result;
        try { result = await response.json(); } catch { observation.schemaValid = false; observation.errorType = 'json_parse_error'; }
        if (result) {
          observation.schemaValid = Object.keys(criteria).every(source => {
            const answer = result?.answers?.[source];
            return answer?.type === 'noul' && typeof answer.noul === 'number' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
          });
          observation.ok = observation.schemaValid;
          observation.returnedModelMatches = result.model === evidence.model;
        }
      } else { observation.errorType = 'http_error'; }
    } catch (error) {
      observation.errorType = error?.name === 'TimeoutError' ? 'deadline_timeout' : error?.name === 'AbortError' ? 'aborted' : 'transport_error';
      const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
      observation.networkCode = safeCode(error?.cause?.code) ?? safeCode(error?.code) ?? null;
      if (Array.isArray(error?.cause?.errors)) observation.networkCodes = [...new Set(error.cause.errors.map(item => safeCode(item.code)).filter(Boolean))];
    }
    observation.elapsedMs = Math.round(performance.now() - started);
    evidence.observations.push(observation);
  }
}
const artifactDir = fileURLToPath(new URL('../../../docs/verification/artifacts/jev-unavailable-2026-10-09/', import.meta.url));
mkdirSync(artifactDir, { recursive: true });
const stamp = evidence.observedAt.replace(/[:.]/g, '-');
const artifactPath = `${artifactDir}service-probe-${stamp}.json`;
writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ ...evidence, artifactPath }));
