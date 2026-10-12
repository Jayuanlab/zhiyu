import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExpectedEvalProvider, configurationHash, normalizeEvalEndpoint,
  evalProviderLockPath, readEvalProviderLock, readLockedEvalProvider, readSavedEvalProvider, snapshotSavedEvalProvider, verifyEvalVersionLock,
} from "../../scripts/lib/platform-eval-v2-provider-lock.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const setting = (overrides: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222", userId: ownerId, providerType: "anthropic_compatible",
  enabled: true, model: "qwen3.7-plus", baseUrl: "https://opencode.ai/zen/go", apiKey: "synthetic-secret-A",
  updatedAt: "2026-10-02T00:00:00.000Z", ...overrides,
});
const fixtures: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const folder of fixtures.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function versionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-eval-provider-lock-")); fixtures.push(root);
  const folder = path.join(root, "package"), runFolder = path.join(folder, "new-run"); fs.mkdirSync(runFolder, { recursive: true });
  fs.writeFileSync(path.join(root, "source.mjs"), "export const runtime = 1;\n"); fs.writeFileSync(path.join(folder, "corpus.jsonl"), '{"raw":"fixture"}\n');
  const hashFile = (filename: string) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  const snapshot = snapshotSavedEvalProvider(setting(), ownerId);
  const body = { schemaVersion: snapshot.schemaVersion, ownerId, folder, runFolder, providers: { agent: snapshot, judge: snapshot },
    sourceHashes: { "source.mjs": hashFile(path.join(root, "source.mjs")) }, packageHashes: { "corpus.jsonl": hashFile(path.join(folder, "corpus.jsonl")) },
    fixedEnvironment: { BRAIN_JEV_MODE: "off" } };
  vi.stubEnv("BRAIN_JEV_MODE", "off");
  const lock = { ...body, lockHash: configurationHash(body) }, filename = path.join(runFolder, "provider-lock.json");
  fs.writeFileSync(filename, JSON.stringify(lock));
  return { root, folder, runFolder, filename, lock };
}

describe("frozen evaluation provider lock", () => {
  it("hashes full normalized endpoint including its path, without serializing credentials", () => {
    const first = snapshotSavedEvalProvider(setting(), ownerId);
    const equivalent = snapshotSavedEvalProvider(setting({ baseUrl: " https://OPENCODE.AI/zen/go/ " }), ownerId);
    expect(equivalent.fingerprint).toBe(first.fingerprint);
    const changed = snapshotSavedEvalProvider(setting({ baseUrl: "https://opencode.ai/zen/other" }), ownerId);
    expect(() => assertExpectedEvalProvider(changed, first)).toThrow("provider_configuration_drift");
    expect(JSON.stringify(first)).not.toContain("synthetic-secret");
    expect(JSON.stringify(first)).not.toContain("/zen/go");
    expect(snapshotSavedEvalProvider(setting({ apiKey: "synthetic-secret-B" }), ownerId).fingerprint).toBe(first.fingerprint);
  });

  it.each([
    { model: "different-model" }, { providerType: "openai_compatible" },
    { updatedAt: "2026-10-02T00:01:00.000Z" }, { id: "new-settings-id" },
  ])("rejects settings drift before accepting a provider: %j", change => {
    const expected = snapshotSavedEvalProvider(setting(), ownerId);
    expect(() => assertExpectedEvalProvider(snapshotSavedEvalProvider(setting(change), ownerId), expected)).toThrow("provider_configuration_drift");
  });

  it.each([{ enabled: false }, { apiKey: "" }, { userId: "foreign-owner" }, { model: "" }, { updatedAt: "invalid" }])("rejects unavailable or unversioned settings: %j", change => {
    expect(() => snapshotSavedEvalProvider(setting(change), ownerId)).toThrow();
  });

  it("rejects credential-bearing endpoint URLs and preserves the OpenCode protocol normalization", () => {
    for (const url of ["https://user:secret@example.invalid/v1", "https://example.invalid/v1?api_key=secret", "https://example.invalid/v1#secret"]) {
      expect(() => normalizeEvalEndpoint(url, "anthropic-messages")).toThrow("provider_endpoint_invalid");
    }
    expect(normalizeEvalEndpoint("https://opencode.ai/zen/go/", "openai-completions")).toBe("https://opencode.ai/zen/go/v1");
  });

  it("uses the formal saved-provider precedence and detects a newly enabled preferred provider", async () => {
    const expected = snapshotSavedEvalProvider(setting(), ownerId);
    const readSetting = vi.fn(async ({ providerType }: { providerType: string }) => providerType === "anthropic_compatible" ? setting() : null);
    const initial = await readSavedEvalProvider({ ownerId, readSetting });
    expect(initial.snapshot.fingerprint).toBe(expected.fingerprint);
    readSetting.mockImplementation(async ({ providerType }) => setting({ providerType }));
    await expect(readLockedEvalProvider({ lock: { ownerId, providers: { agent: expected } }, readSetting })).rejects.toThrow("provider_configuration_drift");
  });

  it("pins the judge separately and never falls back after a failed formal read", async () => {
    const readSetting = vi.fn(async () => setting());
    const judge = await readSavedEvalProvider({ ownerId, role: "judge", readSetting });
    expect(readSetting).toHaveBeenCalledOnce();
    expect(readSetting).toHaveBeenCalledWith({ userId: ownerId, providerType: "anthropic_compatible" });
    const lock = { ownerId, providers: { judge: judge.snapshot } };
    await expect(readLockedEvalProvider({ lock, role: "judge", readSetting: async () => setting({ enabled: false }) })).rejects.toThrow("saved_provider_unavailable");
    await expect(readLockedEvalProvider({ lock, role: "judge", readSetting: async () => { throw Error("private transport detail"); } })).rejects.toThrow("provider_settings_read_failed");
  });

  it("rejects an altered expected snapshot even if a copied fingerprint claims a match", () => {
    const snapshot = snapshotSavedEvalProvider(setting(), ownerId);
    expect(() => assertExpectedEvalProvider(snapshot, { ...snapshot, model: "forged" })).toThrow("provider_lock_invalid");
    expect(configurationHash({ b: 2, a: 1 })).toBe(configurationHash({ a: 1, b: 2 }));
  });

  it("automatically discovers the run-local lock and rejects another run or an altered lock", () => {
    const fixture = versionFixture();
    expect(evalProviderLockPath(undefined, fixture.runFolder)).toBe(fixture.filename);
    expect(readEvalProviderLock(fixture.filename, fixture.runFolder).lockHash).toBe(fixture.lock.lockHash);
    expect(() => readEvalProviderLock(fixture.filename, path.join(fixture.folder, "old-run"))).toThrow("provider_lock_scope_invalid");
    fs.writeFileSync(fixture.filename, JSON.stringify({ ...fixture.lock, ownerId: "another-owner" }));
    expect(() => readEvalProviderLock(fixture.filename, fixture.runFolder)).toThrow("provider_lock_invalid");
  });

  it("checks actual source bytes and package bytes before accepting a version lock", () => {
    const fixture = versionFixture();
    expect(verifyEvalVersionLock(fixture.lock, fixture.root)).toMatchObject({ sourceFileCount: 1, packageFileCount: 1 });
    fs.appendFileSync(path.join(fixture.root, "source.mjs"), "// drift\n");
    expect(() => verifyEvalVersionLock(fixture.lock, fixture.root)).toThrow("evaluation_source_version_drift");
    fs.writeFileSync(path.join(fixture.root, "source.mjs"), "export const runtime = 1;\n");
    fs.appendFileSync(path.join(fixture.folder, "corpus.jsonl"), "{}\n");
    expect(() => verifyEvalVersionLock(fixture.lock, fixture.root)).toThrow("evaluation_package_drift");
  });

  it("treats a missing package file and fixed policy drift as explicit configuration failures", () => {
    const fixture = versionFixture();
    vi.stubEnv("BRAIN_JEV_MODE", "active");
    expect(() => verifyEvalVersionLock(fixture.lock, fixture.root)).toThrow("evaluation_environment_drift");
    vi.stubEnv("BRAIN_JEV_MODE", "off");
    fs.unlinkSync(path.join(fixture.folder, "corpus.jsonl"));
    expect(() => verifyEvalVersionLock(fixture.lock, fixture.root)).toThrow("evaluation_package_drift");
  });

  it("rejects empty pins and traversal or private env paths even when the bytes match", () => {
    const fixture = versionFixture(), expected = fixture.lock.sourceHashes["source.mjs"];
    expect(() => verifyEvalVersionLock({ ...fixture.lock, sourceHashes: {} }, fixture.root)).toThrow("provider_lock_invalid");
    fs.writeFileSync(path.join(fixture.root, ".env"), "export const runtime = 1;\n");
    expect(() => verifyEvalVersionLock({ ...fixture.lock, sourceHashes: { ".env": expected } }, fixture.root)).toThrow("evaluation_source_version_drift");
    expect(() => verifyEvalVersionLock({ ...fixture.lock, sourceHashes: { "../source.mjs": expected } }, fixture.root)).toThrow("evaluation_source_version_drift");
    expect(() => verifyEvalVersionLock({ ...fixture.lock, packageHashes: { "../source.mjs": expected } }, fixture.root)).toThrow("evaluation_package_drift");
  });
  it("checks the immutable workspace marker before case and judge execution",()=>{
    const fixture=versionFixture(),provenanceFile=path.join(fixture.root,"workspace.json");fs.writeFileSync(provenanceFile,"{}\n");
    const workspaceHash="a".repeat(64),provenanceFileHash=createHash("sha256").update(fs.readFileSync(provenanceFile)).digest("hex");
    vi.stubEnv("PLATFORM_EVAL_SOURCE_WORKSPACE",provenanceFile);vi.stubEnv("PLATFORM_EVAL_SOURCE_WORKSPACE_HASH",workspaceHash);
    const lock={...fixture.lock,sourceWorkspace:{provenanceFile,provenanceFileHash,workspaceHash},fixedEnvironment:{...fixture.lock.fixedEnvironment,PLATFORM_EVAL_SOURCE_WORKSPACE:provenanceFile,PLATFORM_EVAL_SOURCE_WORKSPACE_HASH:workspaceHash}};
    expect(verifyEvalVersionLock(lock,fixture.root).sourceFileCount).toBe(1);
    fs.appendFileSync(provenanceFile," ");expect(()=>verifyEvalVersionLock(lock,fixture.root)).toThrow("evaluation_workspace_provenance_drift");
  });
});
