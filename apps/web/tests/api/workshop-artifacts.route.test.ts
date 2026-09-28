import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/(auth)/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env/config/constants", () => ({ getAppDir: vi.fn() }));
vi.mock("@/lib/work-runtime", () => ({ assertWorkAccess: vi.fn() }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshopEvent: vi.fn() }));

import { auth } from "@/app/(auth)/auth";
import { GET } from "@/app/api/workshops/[id]/artifacts/[eventId]/[fileName]/route";
import { getAppDir } from "@/lib/env/config/constants";
import { assertWorkAccess } from "@/lib/work-runtime";
import { getWorkshopEvent } from "@/lib/workshops/service";

const workId = "b0252cc6-8e80-45fa-b125-ead5618bc4ad";
const runId = "a42df8b8-0c8d-84be-ad84-ef2b70153af0";
const eventId = "12345678-1234-1234-1234-123456789abc";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function request(fileName: string) {
  return GET(new Request(`http://localhost/api/workshops/${workId}/artifacts/${eventId}/${fileName}`) as never,
    { params: Promise.resolve({ id: workId, eventId, fileName }) });
}

async function removeFixture(root: string) {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("zhiyu-document-results-")) {
    throw new Error("Unexpected document results fixture cleanup path");
  }
  await rm(target, { recursive: true, force: true });
}

describe("work artifacts", () => {
  let root: string;
  let outputDir: string;
  let metadata: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "zhiyu-document-results-"));
    outputDir = join(root, "sessions", "workshops", workId, runId, "outputs", "source-123");
    await mkdir(outputDir, { recursive: true });
    const document = "# Example\n\nCleaned text.\n";
    const manifest = "{\"source\":\"Example\"}\n";
    const chunk = "# Example\n\nCleaned text.\n";
    await Promise.all([
      writeFile(join(outputDir, "document.md"), document),
      writeFile(join(outputDir, "manifest.json"), manifest),
      writeFile(join(outputDir, "chunk-0001.md"), chunk),
    ]);
    metadata = {
      documentPath: join(outputDir, "document.md"), documentSha256: sha256(document),
      manifestPath: join(outputDir, "manifest.json"), manifestSha256: sha256(manifest),
      chunks: [{ index: 0, path: join(outputDir, "chunk-0001.md"), sha256: sha256(chunk) }],
    };
    vi.mocked(auth).mockResolvedValue({ user: { id: "owner" } } as never);
    vi.mocked(getAppDir).mockReturnValue(root);
    vi.mocked(assertWorkAccess).mockResolvedValue({ id: workId } as never);
    vi.mocked(getWorkshopEvent).mockImplementation(async () => ({
      id: eventId, workshopId: workId, runId, type: "document_converted", metadata,
    }) as never);
  });

  afterEach(async () => {
    await removeFixture(root);
  });

  it("serves only recorded files from the owner's run with verified hashes", async () => {
    for (const [fileName, contentType] of [
      ["document.md", "text/markdown"],
      ["manifest.json", "application/json"],
      ["chunk-0001.md", "text/markdown"],
    ]) {
      const response = await request(fileName);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(contentType);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe(await import("node:fs/promises").then(fs => fs.readFile(join(outputDir, fileName), "utf8")));
    }
    expect(assertWorkAccess).toHaveBeenCalledWith({ userId: "owner", workId });
    expect(getWorkshopEvent).toHaveBeenCalledWith(workId, eventId);
  });

  it("serves generic artifact receipts from any Work event", async () => {
    const fileName = "summary.txt";
    const text = "A verified result.\n";
    const artifactPath = join(dirname(outputDir), fileName);
    await writeFile(artifactPath, text);
    metadata = { artifacts: [{ path: artifactPath, sha256: sha256(text) }] };
    vi.mocked(getWorkshopEvent).mockImplementation(async () => ({
      id: eventId, workshopId: workId, runId, type: "work_artifact_verified", metadata,
    }) as never);
    const response = await request(fileName);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(text);
  });

  it("denies unauthenticated users, other owners and unrelated events", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    expect((await request("document.md")).status).toBe(401);
    expect(assertWorkAccess).not.toHaveBeenCalled();

    vi.mocked(assertWorkAccess).mockRejectedValueOnce(new Error("not owner"));
    expect((await request("document.md")).status).toBe(404);
    expect(getWorkshopEvent).not.toHaveBeenCalled();

    vi.mocked(getWorkshopEvent).mockResolvedValueOnce({ id: eventId, runId: null, type: "decision", metadata } as never);
    expect((await request("document.md")).status).toBe(404);
  });

  it("rejects unrecorded names, paths outside the run and changed files", async () => {
    expect((await request("../document.md")).status).toBe(400);
    expect((await request("chunk-0002.md")).status).toBe(409);

    metadata.documentPath = join(root, "elsewhere", "document.md");
    expect((await request("document.md")).status).toBe(409);

    metadata.documentPath = join(outputDir, "document.md");
    await writeFile(join(outputDir, "document.md"), "Changed after conversion");
    expect((await request("document.md")).status).toBe(409);
  });
});
