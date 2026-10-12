import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PLATFORM_SOURCE_FILES, PLATFORM_SOURCE_READER_VERSION, readPlatformSource } from "@/lib/ai/platform-source-reader";
import { platformSourceMetadata, rankPlatformSourceCandidates } from "@/lib/ai/platform-source-discovery";

const temporaryRoots: string[] = [];
const priorResourceRoot = process.env.ZHIYU_RESOURCE_DIR;
const sourceFixture = (content: string | Buffer) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-source-reader-test-"));
  temporaryRoots.push(root);
  const file = path.join(root, "apps/web/lib/brain/policy.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { root, file };
};
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const candidate = (sourcePath: string, content: string) => ({ sourceId: sourcePath, path: sourcePath, content, sourceHash: digest(content) });
const readPage = async (...args: Parameters<typeof readPlatformSource>) => {
  const result = await readPlatformSource(...args);
  if (result.status !== "read") throw Error(`Expected a source read, received ${result.status}`);
  return result;
};
afterEach(() => {
  vi.restoreAllMocks();
  if (priorResourceRoot === undefined) delete process.env.ZHIYU_RESOURCE_DIR;
  else process.env.ZHIYU_RESOURCE_DIR = priorResourceRoot;
  for (const root of temporaryRoots.splice(0)) {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "zhiyu-source-reader-test-")).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("published implementation reader", () => {
  it("reads every packaged catalog file from a separate data working directory", async () => {
    const { root } = sourceFixture("fixture");
    const resourceRoot = path.join(root, "installed", "app");
    const dataCwd = path.join(root, "data", "app");
    fs.mkdirSync(dataCwd, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(dataCwd);
    process.env.ZHIYU_RESOURCE_DIR = resourceRoot;
    for (const [sourceId, sourcePath] of Object.entries(PLATFORM_SOURCE_FILES)) {
      const file = path.join(resourceRoot, sourcePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = `packaged source: ${sourceId}\n`;
      fs.writeFileSync(file, text, "utf8");
      expect(await readPage({ sourceId })).toMatchObject({ sourceId, sourcePath, content: text, sourceHash: digest(text) });
    }
  });
  it("rejects a relative resource root without falling back to the developer tree", async () => {
    process.env.ZHIYU_RESOURCE_DIR = "../another-installation";
    await expect(readPlatformSource({ sourceId: "memory-policy" })).rejects.toThrow("platform_resource_directory_must_be_absolute");
    await expect(readPlatformSource({})).rejects.toThrow("platform_resource_directory_must_be_absolute");
  });
  it("uses an explicit fixture root before the environment root", async () => {
    const { root } = sourceFixture("explicit fixture wins");
    process.env.ZHIYU_RESOURCE_DIR = "../invalid-env-root";
    expect((await readPage({ sourceId: "memory-policy" }, root)).content).toBe("explicit fixture wins");
  });
  it("retains the developer cwd lookup when no resource root is configured", async () => {
    const { root } = sourceFixture("developer cwd fixture");
    delete process.env.ZHIYU_RESOURCE_DIR;
    vi.spyOn(process, "cwd").mockReturnValue(path.join(root, "apps", "web"));
    expect((await readPage({ sourceId: "memory-policy" })).content).toBe("developer cwd fixture");
  });
  it("lists only the fixed catalog and refuses paths or inherited object keys", async () => {
    expect((await readPlatformSource({})).status).toBe("catalog");
    for (const sourceId of ["../../.env.local", "__proto__", "constructor", "C:/Users/user/.env"]) await expect(readPlatformSource({ sourceId })).rejects.toThrow("catalog");
  });
  it("returns actual policy source with provenance and bounded pagination", async () => {
    const first = await readPage({ sourceId: "memory-policy" });
    expect(first).toMatchObject({ status: "read", sourcePath: "apps/web/lib/brain/policy.ts", startLine: 1, representation: "raw_source_text", readerContractVersion: PLATFORM_SOURCE_READER_VERSION });
    expect(first.content).toContain("canReadMemory");
    expect(first.content).toContain("no_matching_grant");
    expect(first.content!.length).toBeLessThanOrEqual(8000);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const next = await readPage({ sourceId: "memory-policy", startLine: 121 });
    expect(next.contentHash).toBe(first.contentHash);
    expect(next.startLine).toBe(121);
    expect(next.warning).toContain("Current source text is implementation evidence");
  });
  it("reconstructs complete raw text across long lines, CRLF and UTF-16 boundaries", async () => {
    const source = "header\r\n" + "x".repeat(19000) + "\r\n" + "\u4e2d\u6587\ud83d\ude00".repeat(5000) + "\r\nfooter\n";
    const { root } = sourceFixture(source);
    let input: Parameters<typeof readPlatformSource>[0] | null = { sourceId: "memory-policy", offset: 0 };
    let rebuilt = "", pages = 0;
    while (input) {
      const page = await readPage(input, root);
      expect(page).toMatchObject({ status: "read", offset: rebuilt.length, contentHash: digest(source), sourceHash: digest(Buffer.from(source)), representation: "raw_source_text" });
      expect(page.content!.length).toBeLessThanOrEqual(8000);
      rebuilt += page.content;
      input = page.nextRead ?? null;
      if (input) expect(input.offset).toBe(rebuilt.length);
      pages++;
    }
    expect(pages).toBeGreaterThan(4);
    expect(rebuilt).toBe(source);
  });
  it("keeps startLine as an entry point and continues inside the same long line", async () => {
    const source = "head\r\n" + "a".repeat(21000) + "\r\ntail\n", { root } = sourceFixture(source);
    const first = await readPage({ sourceId: "memory-policy", startLine: 2 }, root);
    expect(first).toMatchObject({ status: "read", startLine: 2, offset: 6, nextLine: null, content: "a".repeat(8000) });
    expect(first.nextRead).toMatchObject({ sourceId: "memory-policy", offset: 8006, expectedHash: digest(source) });
    let rebuilt = first.content!, input = first.nextRead;
    while (input) { const page = await readPage(input, root); rebuilt += page.content; input = page.nextRead; }
    expect(rebuilt).toBe(source.slice(6));
  });
  it("refuses to mix file versions and distinguishes byte hash from decoded text hash", async () => {
    const { root, file } = sourceFixture("source body ".repeat(1000));
    const first = await readPage({ sourceId: "memory-policy", offset: 0 }, root);
    fs.writeFileSync(file, "new source version");
    const changed = await readPlatformSource(first.nextRead!, root);
    if (changed.status !== "version_changed") throw Error("Expected the changed source version to be rejected");
    expect(changed).toMatchObject({ status: "version_changed", content: "", nextOffset: null, nextRead: null });
    expect(changed.contentHash).not.toBe(first.contentHash);
    fs.writeFileSync(file, Buffer.from([0x61, 0xff]));
    const decoded = await readPage({ sourceId: "memory-policy", offset: 0 }, root);
    expect(decoded.sourceHash).toBe(digest(Buffer.from([0x61, 0xff])));
    expect(decoded.contentHash).toBe(digest("a\ufffd"));
    expect(decoded.contentHash).not.toBe(decoded.sourceHash);
  });
  it("rejects invalid or mixed continuation inputs and avoids skipping at line boundaries", async () => {
    const source = "x".repeat(7999) + "\nnext line", { root } = sourceFixture(source);
    const first = await readPage({ sourceId: "memory-policy" }, root);
    expect(first).toMatchObject({ nextOffset: 8000, nextLine: 2 });
    expect((await readPage(first.nextRead!, root)).content).toBe("next line");
    for (const input of [{ offset: 0 }, { sourceId: "memory-policy", startLine: 2, offset: 1 }, { sourceId: "memory-policy", startLine: 999 }, { sourceId: "memory-policy", offset: -1 }, { sourceId: "memory-policy", expectedHash: "bad" }]) {
      await expect(readPlatformSource(input, root)).rejects.toThrow();
    }
  });
  it("publishes source purposes without claiming live or approved configuration", async () => {
    const catalog = await readPlatformSource({});
    if (catalog.status !== "catalog") throw Error("Expected catalog");
    expect(catalog.entries).toHaveLength(Object.keys(PLATFORM_SOURCE_FILES).length);
    expect(catalog.entries.find(entry => entry.sourceId === "workspace-model")).toMatchObject({
      sourcePath: "docs/architecture/workshop-workspace-model.md", metadataRole: "retrieval_lead_only",
    });
    expect(catalog.entries.find(entry => entry.sourceId === "runtime-run-snapshot")?.purpose).toContain("does not prove");
    expect(catalog.warning).toContain("not factual evidence");
    for (const sourcePath of Object.values(PLATFORM_SOURCE_FILES)) expect(platformSourceMetadata(sourcePath)?.title).toBeTruthy();
    expect(platformSourceMetadata("__proto__")).toBeUndefined();
  });
  it("resolves only an exact published relative path and preserves canonical continuation IDs", async () => {
    const { root } = sourceFixture("known public policy\n" + "x".repeat(9000));
    const page = await readPage({ sourceId: "apps/web/lib/brain/policy.ts" }, root);
    expect(page.sourceId).toBe("memory-policy");
    expect(page.nextRead?.sourceId).toBe("memory-policy");
    for (const sourceId of ["apps/web/lib/brain/../brain/policy.ts", "apps\\web\\lib\\brain\\policy.ts", "docs/architecture/private-model.md", "file:apps/web/lib/brain/policy.ts"]) {
      await expect(readPlatformSource({ sourceId }, root)).rejects.toThrow("catalog");
    }
  });
  it("returns an actual source span with a version-bound expansion and explicit missing-file failures", async () => {
    const text = "# Header\r\n\r\n" + "unrelated line\r\n".repeat(12) + "canReadMemory enforces memory permissions\r\nlast\r\n";
    const { root, file } = sourceFixture(text);
    const result = await readPlatformSource({ query: "memory permissions", limit: 2 }, root);
    if (result.status !== "search") throw Error("Expected search");
    expect(result).toMatchObject({ readerContractVersion: PLATFORM_SOURCE_READER_VERSION, gapStatus: null, coverage: "published_source_catalog_only" });
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match).toMatchObject({ sourceId: "memory-policy", sourceHash: digest(text), contentHash: digest(text), matchLine: 15, metadataRole: "retrieval_lead_only" });
    expect(match.excerpt).toContain("canReadMemory");
    expect(match.nextRead.offset).toBeGreaterThan(0);
    const page = await readPage(match.nextRead, root);
    expect(page.content).toBe(text.slice(match.nextRead.offset));
    expect(page.startLine).toBe(match.startLine);
    expect(result.unavailable).toContainEqual({ sourceId: "workspace-model", sourcePath: "docs/architecture/workshop-workspace-model.md", status: "source_unavailable", reason: "published_source_missing" });
    expect(JSON.stringify(result)).not.toContain(root);
    fs.writeFileSync(file, "changed version", "utf8");
    expect(await readPlatformSource(match.nextRead, root)).toMatchObject({ status: "version_changed", content: "" });
  });
  it("distinguishes a zero match in a complete published scope from unavailable source files", async () => {
    const { root } = sourceFixture("ordinary policy body");
    const unavailable = await readPlatformSource({ query: "unfindableUniqueToken" }, root);
    expect(unavailable).toMatchObject({ status: "search", matches: [], gapStatus: "source_unavailable" });
    for (const sourcePath of Object.values(PLATFORM_SOURCE_FILES)) {
      const file = path.join(root, sourcePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "ordinary source body", "utf8");
    }
    expect(await readPlatformSource({ query: "unfindableUniqueToken" }, root)).toMatchObject({ status: "search", matches: [], unavailable: [], gapStatus: "not_found_in_published_scope" });
  });
  it("rejects invalid and mixed searches without treating them as empty source evidence", async () => {
    const { root } = sourceFixture("fixture");
    for (const input of [
      { query: "" }, { query: "  " }, { query: "x".repeat(1001) },
      { query: "memory", sourceId: "memory-policy" }, { query: "memory", offset: 0 },
      { query: "memory", startLine: 1 }, { query: "memory", expectedHash: "a".repeat(64) },
      { query: "memory", limit: 0 }, { query: "memory", limit: 13 }, { query: "memory", limit: 1.5 },
      { limit: 1 },
    ]) await expect(readPlatformSource(input, root)).rejects.toThrow();
  });
  it("does not follow a catalog directory junction outside the resource root", async () => {
    const outside = sourceFixture("OUTSIDE_SOURCE_SENTINEL memory permissions");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-source-reader-test-"));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, "apps/web/lib"), { recursive: true });
    fs.symlinkSync(path.dirname(outside.file), path.join(root, "apps/web/lib/brain"), "junction");
    await expect(readPlatformSource({ sourceId: "memory-policy" }, root)).rejects.toThrow("outside the project");
    const search = await readPlatformSource({ query: "memory permissions" }, root);
    expect(search).toMatchObject({ status: "search", matches: [], gapStatus: "permission_denied" });
    expect(search.status === "search" && search.unavailable).toContainEqual({ sourceId: "memory-policy", sourcePath: "apps/web/lib/brain/policy.ts", status: "permission_denied", reason: "published_source_access_rejected" });
    expect(JSON.stringify(search)).not.toContain("OUTSIDE_SOURCE_SENTINEL");
    expect(fs.readFileSync(outside.file, "utf8")).toContain("OUTSIDE_SOURCE_SENTINEL");
  });
});

describe("bounded multilingual source discovery", () => {
  it("finds observation requirements, update methods and rewrite scope from authorized source text", () => {
    const observations = candidate("docs/architecture/engineering-cybernetics-guiding-principles.md", "# 工程控制\n可观测要求输入新鲜度、工具结果、模型依据和下次运行。\n");
    const method = candidate("skills/agent-evolution/SKILL.md", "# 智能体进化\n方法不授予权限，保存与实际装载和生产效果分开。\n");
    const rewrite = candidate("apps/web/lib/brain/query-retry.ts", "export const followup = '查询改写保持原计划范围';\n");
    const noisy = candidate("apps/web/lib/loops/native-scheduler.ts", "export const heartbeat = '已启动';\n".repeat(200));
    expect(rankPlatformSourceCandidates([observations, method, rewrite, noisy], "已启动 输入新鲜度 工具结果 模型依据 可观测", 1)[0].path).toBe(observations.path);
    expect(rankPlatformSourceCandidates([observations, method, rewrite, noisy], "智能体更新 skill 自评分", 1)[0].path).toBe(method.path);
    expect(rankPlatformSourceCandidates([observations, method, rewrite, noisy], "自动补查 查询改写 原计划范围", 1)[0].path).toBe(rewrite.path);
    expect(rankPlatformSourceCandidates([noisy], "智能体进化", 1)).toEqual([]);
  });
  const workspacePath = "docs/architecture/workshop-workspace-model.md";
  const snapshotPath = "apps/web/lib/workshops/runtime-run-snapshot.ts";
  const workspace = candidate(workspacePath, "# 车间、Loop 与运行空间\n\n归属说明\n\n长期成果目录与资料登记、知识纳入的关系需要按该来源核验。\n");
  const snapshot = candidate(snapshotPath, "import type { Snapshot } from './types';\n\nexport function inspectRuntimeRunSnapshot(event) {\n  return event.runtimeRunSnapshot;\n}\n");
  const distractor = candidate("apps/web/lib/workshops/large-domain-tools.ts", "import { workspace, artifacts, knowledge } from './workspace';\n".repeat(250) + "export const unrelatedConversion = true;\n");
  it.each([
    "长期成果目录如何供知识库使用", "车间运行空间的资料登记", "persistent artifacts knowledge ingestion", "WORKSHOP WORKSPACE retained artifacts source registration",
  ])("finds the small policy source for an ordinary topic: %s", query => {
    const matches = rankPlatformSourceCandidates([distractor, workspace, snapshot], query, 3);
    expect(matches[0].path).toBe(workspacePath);
    expect(matches[0].matchedTopics.length).toBeGreaterThan(0);
    expect(matches[0].excerpt).toContain("长期成果目录");
  });
  it.each(["运行时配置实际加载", "loaded runtime config", "RUNTIME CONFIGURATION snapshot", "agent_configured", "workshop version configuration edit save review load", "workshop config version review approved loaded running"]) (
    "finds recorded-run snapshot implementation without treating the source as live proof: %s", query => {
      const matches = rankPlatformSourceCandidates([workspace, distractor, snapshot], query, 1);
      expect(matches[0].path).toBe(snapshotPath);
      expect(matches[0].purpose).toContain("does not prove");
      expect(matches[0].metadataRole).toBe("retrieval_lead_only");
    },
  );
  it("routes a configuration lifecycle question past adjacent review dispositions", () => {
    const review = candidate("apps/web/lib/workshops/review-assistant-decisions.ts", "export const version = 'review';\nconst disposition = 'approved loaded running workshop config';\n");
    for (const query of ["configuration edit save review load", "workshop config version review approved loaded running"]) {
      const matches = rankPlatformSourceCandidates([review, workspace, snapshot], query, 3);
      expect(matches[0].path).toBe(snapshotPath);
      expect(matches[0].matchedTopics).toContain("run_configuration");
    }
  });
  it("resolves a case-insensitive search path but does not invent missing catalog/capture evidence", () => {
    expect(rankPlatformSourceCandidates([workspace, snapshot], workspacePath.toUpperCase(), 1)[0].path).toBe(workspacePath);
    expect(rankPlatformSourceCandidates([], "persistent artifacts", 1)).toEqual([]);
    expect(rankPlatformSourceCandidates([snapshot], "persistent artifacts", 1)).toEqual([]);
  });
  it("does not reward repeated imports or whole-file length and anchors the actual matched sentence", () => {
    const short = candidate("docs/architecture/ordinary-policy.md", "# Policy\n\nEvidence locality\nA source registration boundary applies to this workspace.\n");
    const once = candidate("apps/web/lib/ordinary-tools.ts", "import { registration } from './source';\nexport const source = true;\n");
    const many = { ...once, content: once.content.repeat(400) };
    const oneMatch = rankPlatformSourceCandidates([once], "source registration", 1)[0];
    const manyMatch = rankPlatformSourceCandidates([many], "source registration", 1)[0];
    expect(manyMatch.score).toBe(oneMatch.score);
    const matches = rankPlatformSourceCandidates([many, short], "source registration", 2);
    expect(matches[0]).toMatchObject({ path: short.path, matchLine: 4 });
    expect(matches[0].excerpt).toContain("boundary applies");
  });
  it("preserves exact raw CRLF offsets and distinct byte/text hashes in discovery", () => {
    const content = "# Header\r\n" + "ordinary\r\n".repeat(20) + "runtimeRunSnapshot = input.snapshot;\r\n";
    const source = { ...candidate(snapshotPath, content), sourceHash: "a".repeat(64) };
    const [match] = rankPlatformSourceCandidates([source], "runtimeRunSnapshot", 1);
    expect(match.sourceHash).toBe(source.sourceHash);
    expect(match.contentHash).toBe(digest(content));
    expect(content.slice(match.nextRead.offset).startsWith(match.excerpt)).toBe(true);
    expect(content.slice(0, match.nextRead.offset).split("\n").length).toBe(match.startLine);
    expect(match.nextRead.expectedHash).toBe(digest(content));
  });
  it("caps result count and excerpt size without reading or modifying supplied sources", () => {
    const sources = Array.from({ length: 15 }, (_, index) => candidate(`docs/source-${index}.md`, "memory evidence ".repeat(1000)));
    const before = JSON.stringify(sources);
    const matches = rankPlatformSourceCandidates(sources, "memory evidence", 3);
    expect(matches).toHaveLength(3);
    for (const match of matches) expect(match.excerpt.length).toBeLessThanOrEqual(1200);
    expect(JSON.stringify(sources)).toBe(before);
  });
});
