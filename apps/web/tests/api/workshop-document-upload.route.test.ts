import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));
vi.mock("@/app/(auth)/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env/config/constants", () => ({ getAppDir: vi.fn() }));
vi.mock("@/lib/work-runtime", () => ({ addWorkSource: vi.fn(), assertWorkAccess: vi.fn() }));
vi.mock("@/lib/workshops/service", () => ({ countWorkshopSources: vi.fn() }));

import { auth } from "@/app/(auth)/auth";
import { getAppDir } from "@/lib/env/config/constants";
import { addWorkSource, assertWorkAccess } from "@/lib/work-runtime";
import { countWorkshopSources } from "@/lib/workshops/service";
import { POST } from "@/app/api/workshops/[id]/sources/upload/route";

function requestFor(file: File) {
  const body = new FormData();
  body.set("file", file);
  return new Request("http://localhost/api/workshops/work-1/sources/upload", { method: "POST", body });
}

async function removeFixture(root: string) {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("zhiyu-document-upload-")) {
    throw new Error("Unexpected upload fixture cleanup path");
  }
  await rm(target, { recursive: true, force: true });
}

describe("document cleaner upload", () => {
  let root: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "zhiyu-document-upload-"));
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getAppDir).mockReturnValue(root);
    vi.mocked(assertWorkAccess).mockResolvedValue({ modelConfig: { role: "document_markdown_cleaner" } } as never);
    vi.mocked(countWorkshopSources).mockResolvedValue(0);
    vi.mocked(addWorkSource).mockImplementation(async input => ({ source: { id: "source-1", ...input } } as never));
  });
  afterEach(async () => {
    await removeFixture(root);
  });

  it("stores an owner upload as a local file source with a verifiable hash", async () => {
    const response = await POST(requestFor(new File(["# Example\n"], "report.md", { type: "text/markdown" })) as never,
      { params: Promise.resolve({ id: "work-1" }) });
    expect(response.status).toBe(201);
    const call = vi.mocked(addWorkSource).mock.calls[0][0];
    expect(call).toMatchObject({ userId: "user-1", workId: "work-1", type: "file", name: "report.md" });
    expect(call.config?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const path = fileURLToPath(String(call.uri));
    expect(path.startsWith(join(root, "workshop-sources"))).toBe(true);
    expect(await readFile(path, "utf8")).toBe("# Example\n");
  });

  it("rejects other Work roles and source-count overflow before writing", async () => {
    vi.mocked(assertWorkAccess).mockResolvedValue({ modelConfig: { role: "other" } } as never);
    const file = new File(["text"], "report.txt");
    const forbidden = await POST(requestFor(file) as never, { params: Promise.resolve({ id: "work-1" }) });
    expect(forbidden.status).toBe(403);
    expect(addWorkSource).not.toHaveBeenCalled();

    vi.mocked(assertWorkAccess).mockResolvedValue({ modelConfig: { role: "document_markdown_cleaner" } } as never);
    vi.mocked(countWorkshopSources).mockResolvedValue(1000);
    const full = await POST(requestFor(file) as never, { params: Promise.resolve({ id: "work-1" }) });
    expect(full.status).toBe(409);
    expect(addWorkSource).not.toHaveBeenCalled();
  });
});
