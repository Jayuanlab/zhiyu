import { describe, expect, it } from "vitest";
import { canonicalCommandJson, commandPayloadHash } from "@/lib/work-runtime/command-payload";

describe("command payload identity", () => {
  it("ignores object key order but preserves values and array order", () => {
    expect(commandPayloadHash({b: [1, 2], a: "回测"})).toBe(commandPayloadHash({a: "回测", b: [1, 2]}));
    expect(commandPayloadHash([1, 2])).not.toBe(commandPayloadHash([2, 1]));
    expect(commandPayloadHash({a: null})).not.toBe(commandPayloadHash({}));
    expect(JSON.parse(canonicalCommandJson({"__proto__ field": "中文", a: false}))).toEqual({"__proto__ field": "中文", a: false});
  });
  it.each([undefined, NaN, Infinity, 1n, new Date(), new Map(), {a: undefined}, [undefined], Array(2), () => 1])("rejects lossy non-JSON input %s", value => {
    expect(() => canonicalCommandJson(value)).toThrow();
  });
  it("rejects cycles and symbol keys but permits shared JSON subtrees", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => canonicalCommandJson(cycle)).toThrow();
    expect(() => canonicalCommandJson({[Symbol("hidden")]: 1})).toThrow();
    const shared = {a: 1};
    expect(canonicalCommandJson([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});
