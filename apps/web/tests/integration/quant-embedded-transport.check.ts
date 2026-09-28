import assert from "node:assert/strict";
import {
  closeEmbeddedQuant,
  getEmbeddedQuantStatus,
  quantRequest,
} from "../../lib/quant/embedded-transport";

process.env.QUANT_TRANSPORT = "embedded";
process.env.QUANT_SERVICE_URL = "http://127.0.0.1:8766";
process.env.QUANT_DATA_PROVIDER = "sample";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("embedded quant unexpectedly used HTTP"); };

try {
  const health = await quantRequest("http://127.0.0.1:8766/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const dashboard = await quantRequest("http://127.0.0.1:8766/dashboard");
  assert.equal(dashboard.status, 200);
  const snapshot = await dashboard.json();
  assert.ok(snapshot.market);
  const watchlist = await quantRequest("http://127.0.0.1:8766/watchlist/config");
  assert.equal(watchlist.status, 200);
  const denied = await quantRequest("http://127.0.0.1:8766/watchlist/config", {
    method: "PUT", body: JSON.stringify({ codes: ["600519.SH"] }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(denied.status, 401);
  assert.equal(getEmbeddedQuantStatus().running, true);
  closeEmbeddedQuant();
  const recovered = await quantRequest("http://127.0.0.1:8766/health");
  assert.equal(recovered.status, 200);
  console.log("Embedded quant transport: dashboard, watchlist, write guard and restart passed");
} finally {
  globalThis.fetch = originalFetch;
  closeEmbeddedQuant();
}
