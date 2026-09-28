import assert from "node:assert/strict";
import { config } from "dotenv";
import { closeEmbeddedQuant, quantRequest } from "../../lib/quant/embedded-transport";
import { paperSignedHeaders } from "../../lib/quant/paper-client";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
process.env.QUANT_TRANSPORT = "embedded";

const owner = process.env.QUANT_PAPER_OWNER_ID;
const account = process.env.QUANT_PAPER_ACCOUNT_ID;
assert.ok(owner && account, "paper identity is not configured");
const route = `/paper/v2/accounts/${account}/view`;
const headers = paperSignedHeaders({ ownerId: owner, actorId: `user:${owner}`, role: "owner" }, "GET", route, "");

function stableAccount(value: any) {
  return {
    id: value.id,
    cash: value.cash,
    frozen_cash: value.frozen_cash,
    realized_pnl: value.realized_pnl,
    trading_enabled: value.trading_enabled,
    positions: value.positions?.map((position: any) => ({ code: position.code, quantity: position.quantity })),
  };
}

try {
  const legacy = await fetch(`http://127.0.0.1:8766${route}`, { headers, signal: AbortSignal.timeout(20_000) });
  const embedded = await quantRequest(`http://127.0.0.1:8766${route}`, { headers });
  assert.equal(legacy.status, 200, `legacy paper view returned ${legacy.status}`);
  assert.equal(embedded.status, 200, `embedded paper view returned ${embedded.status}`);
  assert.deepEqual(stableAccount(await embedded.json()), stableAccount(await legacy.json()));
  console.log("Live paper account read: legacy and embedded balances and positions match");
} finally {
  closeEmbeddedQuant();
}
