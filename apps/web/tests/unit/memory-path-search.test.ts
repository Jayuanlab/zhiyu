import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { searchMemoryPathForUser } from "@/lib/ai/memory-path-search";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("memory path search adapter", () => {
  it("searches memory files without shell commands", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhiyu-memory-"));
    await mkdir(join(tempDir, "projects"), { recursive: true });
    await writeFile(
      join(tempDir, "projects", "zhiyu-plan.md"),
      "Pi migration memory path search should stay read-only.",
      "utf8",
    );

    const result = await searchMemoryPathForUser({
      memoryPath: tempDir,
      directory: "projects",
      query: "migration",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        query: "migration",
        fileCount: 0,
        matchCount: 1,
      },
    });
    expect(result.text).toContain("zhiyu-plan.md");
    expect(result.text).toContain("Pi migration memory path search");
  });

  it("rejects directories outside the memory root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhiyu-memory-"));

    await expect(
      searchMemoryPathForUser({
        memoryPath: tempDir,
        directory: "..",
        query: "secret",
      }),
    ).rejects.toThrow("Directory is outside the memory root.");
  });
});

