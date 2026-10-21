import { fileURLToPath } from 'node:url';
import { fetchTypesafe } from "../lib/memory/retrieval/jev-fetch.ts";

// Synthetic data only. Never print credentials or raw provider errors.
process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error('TYPESAFE_API_KEY is missing');
const started = Date.now();
try {
  const response = await fetchTypesafe('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: 'jev-1.13.0',
      state: 'Synthetic test: the project uses PostgreSQL as its database.',
      questions: {
        supported: { type: 'noul', instructions: 'Does the state explicitly say the project uses PostgreSQL?' },
        unsupported: { type: 'noul', instructions: 'Does the state explicitly say the project uses Redis?' },
      },
    }),
  });
  if (!response.ok) {
    console.log(JSON.stringify({ ok: false, status: response.status, elapsedMs: Date.now() - started }));
    process.exitCode = 1;
  } else {
    const result = await response.json();
    const supported = result.answers?.supported?.noul;
    const unsupported = result.answers?.unsupported?.noul;
    const ok = typeof supported === 'number' && supported > 0.5
      && typeof unsupported === 'number' && unsupported < 0.5;
    console.log(JSON.stringify({ ok, status: response.status, model: result.model,
      supported, unsupported, usage: result.usage, elapsedMs: Date.now() - started }));
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, errorType: error.name, elapsedMs: Date.now() - started }));
  process.exitCode = 1;
}
