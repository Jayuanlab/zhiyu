import fs from 'node:fs';

const base = 'http://127.0.0.1:3515';
async function read(path) {
  const start = Date.now();
  try {
    const response = await fetch(path.startsWith('http') ? path : base + path, {signal: AbortSignal.timeout(45000)});
    return {status: response.status, ms: Date.now()-start, body: await response.json()};
  } catch (error) { return {error: error.message, ms: Date.now()-start}; }
}
function quant(data) {
  if (!data) return null;
  return {
    keys: Object.keys(data), serviceMode: data.service_mode, provider: data.data_provider,
    sourceDetail: data.data_source_detail, providerError: data.provider_error,
    generatedAt: data.generated_at, updatedAt: data.updated_at,
    marketDate: data.market?.trade_date ?? data.market?.date, marketUpdatedAt: data.market?.updated_at,
    marketScope: data.market?.market_scope, marketWarning: data.market?.market_warning,
    marketProviderError: data.market?.provider_error, marketTemperature: data.market?.temperature,
    marketUpCount: data.market?.up_count, marketDownCount: data.market?.down_count,
    watchlistCodes: (data.watchlist ?? []).map(row => row.code),
    quoteTimes: [...new Set((data.watchlist ?? []).map(row => row.updated_at))],
    cache: data.cache,
  };
}
function digest(data) {
  return data ? {counts:data.counts, generatedAt:data.generatedAt, window:data.window,
    oldestTaskAt: data.pendingTasks?.at(-1)?.createdAt,
    newestTaskAt: data.pendingTasks?.[0]?.createdAt} : null;
}
function sanitizeRuntime(value) {
  if (Array.isArray(value)) return value.map(sanitizeRuntime);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['userId', 'sourceId', 'sourceName'].includes(key))
    .map(([key, entry]) => [key, sanitizeRuntime(entry)]));
}
const [runtime, session, pageQuant, serviceQuant, shortDigest, longDigest, works] = await Promise.all([
  read('/api/runtime/status'), read('/api/auth/session'), read('/api/page-state/quant'),
  read('http://127.0.0.1:8766/dashboard'),
  read('/api/interactions/todo-digest?limit=12&sinceDays=7'),
  read('/api/interactions/todo-digest?limit=100&sinceDays=7'),
  read('/api/page-state/workshop'),
]);
const result = {
  measuredAt: new Date().toISOString(),
  runtime: sanitizeRuntime(runtime.body),
  auth: {status: session.status, anonymousHasUser: !!session.body?.user},
  pageQuant: {status:pageQuant.status,ms:pageQuant.ms,error:pageQuant.error,meta:pageQuant.body?.meta,
    dashboard:quant(pageQuant.body?.dashboard),accountUpdatedAt:pageQuant.body?.account?.updated_at},
  serviceQuant: {status:serviceQuant.status,ms:serviceQuant.ms,error:serviceQuant.error,dashboard:quant(serviceQuant.body)},
  digest12: digest(shortDigest.body), digest100: digest(longDigest.body),
  workshopChecks: [],
};
const ids=(works.body?.workshops ?? []).slice(0,3).map(w => w.id ?? w.workshop?.id);
for (const [index,id] of ids.entries()) {
  const [summary,events,dashboard] = await Promise.all([
    read(`/api/page-state/workshop/${id}/summary?refresh=1`),
    read(`/api/workshops/${id}/events?limit=100`),
    read(`/api/workshops/${id}/dashboard`),
  ]);
  const s=summary.body?.events ?? [], e=events.body?.events ?? [];
  result.workshopChecks.push({index,statuses:[summary.status,events.status,dashboard.status],
    summary:{count:s.length,firstSeq:s[0]?.seq,lastSeq:s.at(-1)?.seq,counts:summary.body?.dashboard?.counts},
    events:{count:e.length,firstSeq:e[0]?.seq,lastSeq:e.at(-1)?.seq},
    dashboardCounts:dashboard.body?.counts,
  });
}
const file = new URL(process.argv[2] || './2026-09-06-production-recheck.json', import.meta.url);
fs.writeFileSync(file, JSON.stringify(result,null,2)+'\n','utf8');
console.log(JSON.stringify(result,null,2));
