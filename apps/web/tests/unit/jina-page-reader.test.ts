import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanWebPage } from "@/lib/ai/web-page-cleaner";
import { readJinaDefuddlePage } from "@/lib/ai/jina-page-reader";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = `<html><head><title>Transformer guide</title></head><body><nav>UNWANTED NAVIGATION</nav><article><h1>Transformer guide</h1><p>${"Attention uses queries keys and values. ".repeat(30)}</p><pre><code class="language-python">print("preserve code")</code></pre><p>Attention(Q,K,V) = softmax(QK/sqrt(d))V</p><svg><text>Query</text><text>Key</text><path d="M0 0"/></svg><h2>Final section</h2><p>TAIL EVIDENCE</p></article><footer>UNWANTED FOOTER</footer></body></html>`;
async function options(body = fixture, status = 200) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-web-reader-test-")); roots.push(root);
  return { root, fetcher: vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(body, { status, headers: { "x-usage-tokens": "123" } })) };
}
describe("Jina HTML and Defuddle evidence", () => {
  it("removes boilerplate, preserves code and labels diagrams honestly", async () => {
    const result = await cleanWebPage(fixture, "https://example.com/article");
    expect(result.content).toContain('print("preserve code")');
    expect(result.content).toContain("softmax");
    expect(result.content).toContain("Query");
    expect(result.content).not.toContain("<svg");
    expect(result.content).not.toContain("UNWANTED");
    expect(result.warnings).toContain("figures_require_on_demand_visual_read");
    expect(result.figures[0].markup).toContain("<svg");
  });
  it("saves raw and clean evidence and continues without another upstream request", async () => {
    const opts = await options();
    const first = await readJinaDefuddlePage({ url: "https://example.com/article", scope: "user:A", maxChars: 300 }, opts);
    expect(first.truncated).toBe(true);
    expect(first.providerUsageTokens).toBe(123);
    expect(opts.fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { "X-Return-Format": "html" } });
    const rest = await readJinaDefuddlePage({ url: first.url, scope: "user:A", evidenceId: first.evidenceId, offset: first.nextOffset! }, opts);
    expect(rest.content).toContain("TAIL EVIDENCE");
    expect(rest.contentHash).toBe(first.contentHash);
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    const { createHash } = await import("node:crypto");
    const dir = join(opts.root, createHash("sha256").update("user:A").digest("hex"), first.evidenceId);
    expect(await readFile(join(dir, "raw.html"), "utf8")).toBe(fixture);
    expect(await readFile(join(dir, "clean.md"), "utf8")).toBe(first.content + rest.content);
    await expect(readJinaDefuddlePage({ url: first.url, scope: "user:B", evidenceId: first.evidenceId }, opts)).rejects.toThrow();
    await expect(readJinaDefuddlePage({ url: "https://example.com/other", scope: "user:A", evidenceId: first.evidenceId }, opts)).rejects.toThrow("mismatch");
  });
  it("does not retry auth failures or pass error pages to the cleaner", async () => {
    const opts = await options("blocked", 403);
    await expect(readJinaDefuddlePage({ url: "https://example.com", scope: "A" }, opts)).rejects.toThrow("403");
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    await expect(cleanWebPage("Title: fake\nMarkdown Content: not HTML", "https://example.com")).rejects.toThrow("HTML");
    await expect(cleanWebPage("<html><head><title>Access denied</title></head><body><p>Blocked</p></body></html>", "https://example.com")).rejects.toThrow();
  });
  it("bounds response size, refuses private URLs and checks cancellation", async () => {
    const opts = await options("x".repeat(2 * 1024 * 1024 + 1));
    await expect(readJinaDefuddlePage({ url: "https://example.com", scope: "A" }, opts)).rejects.toThrow("budget");
    opts.fetcher.mockClear();
    await expect(readJinaDefuddlePage({ url: "http://127.0.0.1", scope: "A" }, opts)).rejects.toThrow("public");
    await expect(readJinaDefuddlePage({ url: "https://example.com", scope: "A", signal: AbortSignal.abort() }, opts)).rejects.toThrow();
    expect(opts.fetcher).not.toHaveBeenCalled();
  });
});
