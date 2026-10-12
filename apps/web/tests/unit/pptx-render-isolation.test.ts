import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => fixture.home,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@/lib/utils/logger", () => ({ workspaceLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
import { isRenderEngineAvailable } from "@/lib/files/pptx-render";

let root: string;
let appDir: string;
function installEngineMetadata(base: string) {
  const engineDir = join(base, "render-engines", "office");
  mkdirSync(engineDir, { recursive: true });
  const soffice = join(engineDir, "soffice-fixture.exe");
  const pdftoppm = join(engineDir, "pdftoppm-fixture.exe");
  writeFileSync(soffice, "fixture only", "utf8");
  writeFileSync(pdftoppm, "fixture only", "utf8");
  const metadata = join(engineDir, "installed.json");
  writeFileSync(metadata, JSON.stringify({ soffice_path: soffice, pdftoppm_path: pdftoppm }), "utf8");
  return metadata;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zhiyu-pptx-isolation-"));
  fixture.home = join(root, "old-home");
  appDir = join(root, "private", "app-data");
  vi.stubEnv("HOME", fixture.home);
  vi.stubEnv("USERPROFILE", fixture.home);
  vi.stubEnv("ZHIYU_APP_DATA_DIR", appDir);
  for (const key of ["PATH", "SOFFICE_BIN", "PDFTOPPM_BIN", "RESOURCE_DIR"]) vi.stubEnv(key, "");
  vi.mocked(readFileSync).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (!basename(root).startsWith("zhiyu-pptx-isolation-") || join(tmpdir(), basename(root)) !== root) throw Error("unsafe_fixture_cleanup");
  rmSync(root, { recursive: true, force: true });
});

describe("PPTX render engine metadata isolation", () => {
  it("loads installed engine metadata from the explicit app data directory", () => {
    const metadata = installEngineMetadata(appDir);
    installEngineMetadata(join(fixture.home, ".openzhiyu"));
    expect(isRenderEngineAvailable()).toBe(true);
    expect(vi.mocked(readFileSync).mock.calls.map(([file]) => String(file))).toEqual([metadata]);
  });
  it("does not use an old home installation when the private installation has no engine", () => {
    installEngineMetadata(join(fixture.home, ".openzhiyu"));
    expect(isRenderEngineAvailable()).toBe(false);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
  });
  it("keeps the existing home metadata location without an app data override", () => {
    delete process.env.ZHIYU_APP_DATA_DIR;
    const metadata = installEngineMetadata(join(fixture.home, ".openzhiyu"));
    expect(isRenderEngineAvailable()).toBe(true);
    expect(vi.mocked(readFileSync).mock.calls.map(([file]) => String(file))).toEqual([metadata]);
  });
  it("exposes an unavailable engine for malformed private metadata without reading the old home", () => {
    const metadata = installEngineMetadata(appDir);
    writeFileSync(metadata, "invalid metadata", "utf8");
    installEngineMetadata(join(fixture.home, ".openzhiyu"));
    expect(isRenderEngineAvailable()).toBe(false);
    expect(vi.mocked(readFileSync).mock.calls.map(([file]) => String(file))).toEqual([metadata]);
  });
});
