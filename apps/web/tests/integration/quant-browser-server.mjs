import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export async function runQuantBrowserCheck({ env, databaseUrl, client, web, root }) {
  const userId = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${userId},'quant-review@example.invalid')`;
  const control = path.join(web, ".tmp/quant-review-control.json");
  fs.writeFileSync(control, JSON.stringify({phase: "warming"}));
  const requests = [];
  const account = {id: "fixture", mode: "paper", trading_enabled: false, initial_cash: 1000, cash: 1000, frozen_cash: 0,
    market_value: 0, total_asset: 1000, realized_pnl: 0, total_pnl: 0, total_pnl_pct: 0,
    positions: [], open_orders: [], recent_orders: [], recent_fills: [], rules: {}, updated_at: "2026-09-04T15:00:00+08:00"};
  const server = http.createServer((request, response) => {
    const {phase} = JSON.parse(fs.readFileSync(control, "utf8"));
    requests.push({at: new Date().toISOString(), path: request.url, method: request.method, phase});
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET") { response.writeHead(405).end('{}'); return; }
    if (phase === "offline") { response.writeHead(503).end('{"detail":"fixture provider offline"}'); return; }
    if (request.url === "/paper/account/view") { response.end(JSON.stringify(account)); return; }
    if (request.url === "/watchlist") { response.end(JSON.stringify({codes: [], items: []})); return; }
    if (request.url !== "/dashboard") { response.writeHead(404).end('{}'); return; }
    const warming = phase === "warming";
    const now = new Date().toISOString();
    const quality = {schemaVersion: "quant-quality.v1", provider: "fixture", detail: "isolated regression",
      scope: warming ? "watchlist" : "full_market", observedAt: "2026-09-04T15:00:00+08:00", fetchedAt: now,
      generatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), refreshing: warming,
      lastRefreshError: null, warnings: [], qualityStatus: warming ? "degraded" : "ready",
      exchange: "CN_A", quoteSessionDate: "2026-09-04", calendarVersion: null};
    response.end(JSON.stringify({generated_at: now, service_mode: "live", data_provider: "fixture", quality,
      market: {market_scope: warming ? "watchlist_fallback" : "full_market", trade_date: "2026-09-04",
        temperature: warming ? 100 : 46, up_count: warming ? 1 : 2444, down_count: warming ? 0 : 2913,
        flat_count: 0, turnover_billion: 0, indices: [], sectors: []}, watchlist: [], signals: [],
      portfolio: {mode: "paper", total_value: 1000, cash: 1000, positions: [], daily_pnl: 0},
      daily_report: {summary: "Isolated fixture", next_actions: []}}));
  });
  await new Promise((resolve, reject) => {server.once("error", reject); server.listen(8767, "127.0.0.1", resolve);});
  const log = fs.openSync(path.join(web, ".tmp/quant-review-server.log"), "w");
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", "3517", "-H", "127.0.0.1"], {
    cwd: web, windowsHide: true, stdio: ["ignore", log, log],
    env: {...env, NODE_ENV: "production", ZHIYU_REVIEW_BUILD: "03", DEV_USER_ID: userId,
      POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, QUANT_TRANSPORT: "http", QUANT_SERVICE_URL: "http://127.0.0.1:8767",
      ENABLE_LOCAL_SCHEDULER: "false", ENABLE_STARTUP_LISTENERS: "false", TAURI_MODE: "0", IS_TAURI: "false",
      QUANT_READ_CACHE_TTL_MS: "500", QUANT_PAGE_STATE_CACHE_TTL_MS: "500"},
  });
  let spawnError;
  child.once("error", error => {spawnError = error;});
  console.log(JSON.stringify({phase: "browser-ready", origin: "http://127.0.0.1:3517/quant", control}));
  try {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && JSON.parse(fs.readFileSync(control, "utf8")).phase !== "stop") {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("Review server exited early");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (child.exitCode === null && !spawnError) { child.kill(); await exited; }
    await new Promise(resolve => server.close(resolve));
    fs.closeSync(log);
    fs.writeFileSync(path.join(root, "docs/plans/2026-09-06-review-remediation/records/03-browser-requests.json"), JSON.stringify(requests, null, 2));
  }
  if (requests.some(request => request.method !== "GET" || request.path === "/paper/account")) throw new Error("Browser reached a mutation endpoint");
  return {name: "isolated browser session", requests: requests.length, noMutationRequests: true};
}
