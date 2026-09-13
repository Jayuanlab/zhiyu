import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryWriteRoutes } from "../../scripts/inventory-write-routes.mjs";
import { assertAuthBinding } from "../../scripts/auth-bind-policy.mjs";

describe("identity entry inventory", () => {
  it("requires review of new or changed HTTP write entry points", () => {
    const saved = JSON.parse(readFileSync(resolve("../../docs/plans/2026-09-06-review-remediation/records/05-write-routes.json"), "utf8"));
    expect(inventoryWriteRoutes()).toEqual(saved.entries);
  });
  it("refuses local-owner startup without explicit loopback binding", () => {
    for (const argv of [[], ["-H", "0.0.0.0"], ["--hostname=192.168.1.2"]]) expect(() => assertAuthBinding("local_owner", argv)).toThrow();
    expect(() => assertAuthBinding("local_owner", ["-H", "127.0.0.1"])).not.toThrow();
  });
});
