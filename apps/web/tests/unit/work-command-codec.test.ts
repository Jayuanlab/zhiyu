import {describe, expect, it} from "vitest";
import {encodeCommandResult, decodeCommandResult} from "@/lib/work-runtime/database-command";
import {commandPayloadHash} from "@/lib/work-runtime/command-payload";

describe("database command receipt codec", () => {
  it("preserves dates and leaves ordinary timestamp strings unchanged", () => {
    const value = {at: new Date("2026-09-06T00:00:00Z"), nested: [{at: "2026-09-06T00:00:00Z"}], optional: undefined};
    expect(decodeCommandResult(encodeCommandResult(value))).toEqual({...value, optional: undefined});
  });
  it("identifies equivalent date-bearing payloads regardless of object field order", () => {
    const at = new Date("2026-09-06T00:00:00Z"), later = new Date("2026-09-07T00:00:00Z");
    expect(commandPayloadHash(encodeCommandResult({a: at, b: later}))).toBe(commandPayloadHash(encodeCommandResult({b: later, a: at})));
  });
  it("rejects invalid dates and cycles before accepting a command", () => {
    expect(() => encodeCommandResult({at: new Date("invalid")})).toThrow("Invalid command date");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => encodeCommandResult(cycle)).toThrow("Cyclic command value");
  });
});
