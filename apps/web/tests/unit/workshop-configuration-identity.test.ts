import {describe, expect, it} from "vitest";
import {nextConfigurationVersion, preserveManifestIdentity, protectManifestIdentity} from "@/lib/workshops/configuration-identity";

describe("configuration identity and logical revision", () => {
  it("keeps import identity through ordinary replacement and snapshot restoration", () => {
    expect(protectManifestIdentity({manifestName: "original"}, {model: "new"})).toEqual({model: "new", manifestName: "original"});
    expect(() => protectManifestIdentity({manifestName: "original"}, {manifestName: "other"})).toThrow("manifest_identity_reserved");
    expect(() => protectManifestIdentity({}, {manifestName: "forged"})).toThrow("manifest_identity_reserved");
    expect(preserveManifestIdentity({manifestName: "current"}, {manifestName: "old", model: "old"})).toEqual({manifestName: "current", model: "old"});
    expect(preserveManifestIdentity({}, {manifestName: "old"})).toEqual({});
    expect(protectManifestIdentity({manifestName: "original"}, {manifestName: "reviewed"}, true)).toEqual({manifestName: "reviewed"});
  });
  it("advances during identical milliseconds, clock rollback, and a prior logical revision", () => {
    const now = new Date("2026-09-06T00:00:00.000Z");
    const first = nextConfigurationVersion(now, {}, now);
    const second = nextConfigurationVersion(now, {workVersion: first}, now);
    expect(first).toBe("2026-09-06T00:00:00.001Z");
    expect(second).toBe("2026-09-06T00:00:00.002Z");
    expect(nextConfigurationVersion(now, {workVersion: second}, new Date("2020-01-01"))).toBe("2026-09-06T00:00:00.003Z");
  });
});
