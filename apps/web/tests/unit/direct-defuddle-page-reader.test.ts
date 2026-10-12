import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebEvidence, readDirectDefuddlePage, readJinaDefuddlePage, webEvidenceDirectory } from "@/lib/ai/jina-page-reader";
import { cleanWebPage } from "@/lib/ai/web-page-cleaner";
import { readWithWebFallback } from "@/lib/workshops/web-fetch";

const faults = vi.hoisted(() => ({ file: "", abortAfter: "", controller: null as AbortController | null }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    if (faults.file && String(args[0]).endsWith(faults.file)) throw Error("Simulated evidence persistence failure");
    const result = await actual.writeFile(...args);
    if (faults.abortAfter && String(args[0]).endsWith(faults.abortAfter)) faults.controller?.abort();
    return result;
  }) };
});

const roots: string[] = [];
afterEach(async () => {
  faults.file = ""; faults.abortAfter = ""; faults.controller = null;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const url = "https://example.com/research";
const scope = "workshop:reader-review56";
const html = `<html><head><title>Research article</title></head><body><nav>REMOVE NAVIGATION</nav><article><h1>Research article</h1><p>${"The method compares sampled rewards with the baseline and retains the qualified conclusion. ".repeat(80)}</p><pre><code>score = reward - baseline</code></pre><p>Accuracy may improve under the stated conditions.</p><svg><text>Policy</text><text>Reward</text></svg><h2>Final limitations</h2><p>TAIL ORIGINAL EVIDENCE: visual details require separate inspection.</p></article><script>globalThis.readerExecuted = true</script><footer>REMOVE FOOTER</footer></body></html>`;
async function setup(body = html, status = 200) {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-direct-defuddle-")); roots.push(root);
  const fetcher = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
  return { root, fetcher };
}
async function patchSnapshot(root: string, evidenceId: string, patch: Record<string, unknown>) {
  const file = join(webEvidenceDirectory(scope, evidenceId, root), "snapshot.json");
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...snapshot, ...patch }), "utf8");
}

describe("explicit direct HTTP plus local Defuddle evidence fallback", () => {
  it("falls back only when explicitly composed after a non-retried Jina 403 and saves true provider metadata", async () => {
    const opts = await setup();
    const jina = vi.fn(async () => new Response("Jina denied", { status: 403 }));
    const errors: string[] = [];
    vi.stubEnv("JINA_API_KEY", "must-never-reach-direct-target");
    const result = await readWithWebFallback(
      () => readJinaDefuddlePage({ url, scope, maxChars: 300 }, { root: opts.root, fetcher: jina }),
      () => readDirectDefuddlePage({ url, scope, maxChars: 300 }, opts), errors,
    );
    expect(jina).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(["Jina Reader HTTP 403"]);
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    expect(opts.fetcher.mock.calls[0]?.[0]).toBe(url);
    const init = opts.fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("X-Return-Format")).toBe(false);
    expect(result).toMatchObject({ provider: "direct_http", method: "direct_defuddle", qualityScore: 80, providerUsageTokens: null });
    expect(result.warnings).toContain("direct_http_fallback_local_defuddle");
    expect(result.warnings).toContain("extraction_not_independently_verified");
    const { snapshot, directory } = await loadWebEvidence(scope, result.evidenceId, url, opts.root);
    expect(snapshot).toMatchObject({ provider: "direct_http", method: "direct_defuddle", scopeHash: createHash("sha256").update(scope).digest("hex") });
    expect(await readFile(join(directory, "raw.html"), "utf8")).toBe(html);
    expect(await readFile(join(directory, "clean.md"), "utf8")).toBe((await cleanWebPage(html, url)).content);
    expect(snapshot.rawHash).toBe(createHash("sha256").update(html).digest("hex"));
    expect(snapshot.contentHash).toBe(createHash("sha256").update(snapshot.content).digest("hex"));
  });

  it("uses saved true origin through either continuation entry, covers the tail, and persists exact contiguous windows", async () => {
    const opts = await setup();
    let current = await readDirectDefuddlePage({ url, scope, maxChars: 900 }, opts);
    const first = current;
    const pieces = [current.content];
    while (current.nextOffset !== null) {
      current = await readJinaDefuddlePage({ url, scope, evidenceId: first.evidenceId, offset: current.nextOffset, maxChars: 900 }, opts);
      expect(current).toMatchObject({ provider: "direct_http", method: "direct_defuddle", contentHash: first.contentHash });
      expect(current.warnings).toContain("direct_http_fallback_local_defuddle");
      pieces.push(current.content);
    }
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    const directory = webEvidenceDirectory(scope, first.evidenceId, opts.root);
    const body = await readFile(join(directory, "clean.md"), "utf8");
    expect(pieces.join("")).toBe(body);
    expect(pieces.at(-1)).toContain("TAIL ORIGINAL EVIDENCE");
    expect(pieces.join("").length).toBe(first.totalChars);
    const windows = (await readdir(directory)).filter(file => file.startsWith("window-"));
    expect(windows.length).toBe(pieces.length);
    for (const file of windows) {
      const receipt = JSON.parse(await readFile(join(directory, file), "utf8"));
      expect(receipt.content).toBe(body.slice(receipt.offset, receipt.offset + 900));
      expect(receipt.provider).toBe("direct_http");
    }
  });

  it("keeps saved Jina origin on the direct continuation entry and accepts a genuine legacy Jina snapshot", async () => {
    const opts = await setup();
    const first = await readJinaDefuddlePage({ url, scope, maxChars: 300 }, opts);
    const file = join(webEvidenceDirectory(scope, first.evidenceId, opts.root), "snapshot.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    delete snapshot.provider; delete snapshot.method; delete snapshot.scopeHash;
    delete snapshot.finalUrl; delete snapshot.finalUrlVerified; delete snapshot.retrievalWarnings;
    await writeFile(file, JSON.stringify(snapshot), "utf8");
    const rest = await readDirectDefuddlePage({ url, scope, evidenceId: first.evidenceId, offset: first.nextOffset! }, opts);
    expect(rest).toMatchObject({ provider: "jina_reader", method: "jina_defuddle", finalUrlVerified: false });
    expect(rest.warnings).not.toContain("direct_http_fallback_local_defuddle");
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong ID", { evidenceId: "11111111-1111-1111-1111-111111111111" }],
    ["wrong scope seal", { scopeHash: "0".repeat(64) }],
    ["wrong content hash", { contentHash: "0".repeat(64) }],
    ["wrong raw hash", { rawHash: "0".repeat(64) }],
    ["conflicting provider", { provider: "jina_reader" }],
    ["missing one origin field", { method: null }],
    ["wrong saved destination", { finalUrl: "https://example.com/another-document" }],
    ["missing modern provenance", { finalUrlVerified: null }],
  ])("rejects cache %s before any continuation network or receipt", async (_label, patch) => {
    const opts = await setup();
    const first = await readDirectDefuddlePage({ url, scope, maxChars: 300 }, opts);
    await patchSnapshot(opts.root, first.evidenceId, patch);
    await expect(readDirectDefuddlePage({ url, scope, evidenceId: first.evidenceId, offset: 300 }, opts)).rejects.toThrow();
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects another scope, URL, invalid offsets, and changed saved raw or clean bytes", async () => {
    const opts = await setup();
    const first = await readDirectDefuddlePage({ url, scope, maxChars: 300 }, opts);
    await expect(readDirectDefuddlePage({ url, scope: "workshop:other", evidenceId: first.evidenceId }, opts)).rejects.toThrow();
    await expect(readDirectDefuddlePage({ url: "https://example.com/other", scope, evidenceId: first.evidenceId }, opts)).rejects.toThrow("mismatch");
    await expect(readDirectDefuddlePage({ url, scope, evidenceId: first.evidenceId, offset: first.totalChars + 1 }, opts)).rejects.toThrow("Offset");
    await expect(readDirectDefuddlePage({ url, scope, offset: 1 }, opts)).rejects.toThrow("evidenceId");
    await expect(readDirectDefuddlePage({ url, scope, maxChars: 30_001 }, opts)).rejects.toThrow("window");
    const directory = webEvidenceDirectory(scope, first.evidenceId, opts.root);
    await writeFile(join(directory, "raw.html"), `${html}tampered`, "utf8");
    await expect(loadWebEvidence(scope, first.evidenceId, url, opts.root)).rejects.toThrow("mismatch");
    await writeFile(join(directory, "raw.html"), html, "utf8");
    await writeFile(join(directory, "clean.md"), "changed", "utf8");
    await expect(readJinaDefuddlePage({ url, scope, evidenceId: first.evidenceId }, opts)).rejects.toThrow("mismatch");
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 500])("does not retry direct HTTP %s or save an error page", async status => {
    const opts = await setup(html, status);
    await expect(readDirectDefuddlePage({ url, scope }, opts)).rejects.toThrow(String(status));
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(opts.root)).toEqual([]);
  });

  it("bounds HTML, sanitizes transport errors, and refuses private or redirect destinations", async () => {
    const large = await setup("x".repeat(2 * 1024 * 1024 + 1));
    await expect(readDirectDefuddlePage({ url, scope }, large)).rejects.toThrow("budget");
    const opts = await setup();
    await expect(readDirectDefuddlePage({ url: "http://127.0.0.1", scope }, opts)).rejects.toThrow("public");
    expect(opts.fetcher).not.toHaveBeenCalled();
    const failing = vi.fn(async () => { throw Error("proxy credential https://secret:token@proxy.example"); });
    await expect(readDirectDefuddlePage({ url, scope }, { root: opts.root, fetcher: failing })).rejects.toThrow("Direct HTML retrieval failed");
    expect(failing).toHaveBeenCalledTimes(1);
    const redirected = vi.fn(async () => {
      const response = new Response(html, { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: "http://127.0.0.1/admin" });
      return response;
    });
    await expect(readDirectDefuddlePage({ url, scope }, { root: opts.root, fetcher: redirected })).rejects.toThrow();
    expect(await readdir(opts.root)).toEqual([]);
  });

  it.each([
    "Title: Fake\nMarkdown Content: not article HTML",
    "<html><head><title>Access denied</title></head><body><p>Blocked</p></body></html>",
    "<html><head><title>Sign in</title></head><body><p>Authentication required</p></body></html>",
  ])("rejects non-article content instead of producing scientific body evidence", async body => {
    const opts = await setup(body);
    await expect(readDirectDefuddlePage({ url, scope }, opts)).rejects.toThrow();
    expect(await readdir(opts.root)).toEqual([]);
  });

  it("retains scientific qualifiers, code and visual warnings without executing page resources", async () => {
    const opts = await setup();
    const result = await readDirectDefuddlePage({ url, scope }, opts);
    expect(result.content).toContain("Accuracy may improve under the stated conditions.");
    expect(result.content).toContain("score = reward - baseline");
    expect(result.content).toContain("Policy");
    expect(result.content).not.toContain("REMOVE");
    expect(result.warnings).toContain("figures_require_on_demand_visual_read");
    expect(result.figures[0]?.status).toBe("not_interpreted");
    expect((globalThis as Record<string, unknown>).readerExecuted).toBeUndefined();
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    expect(result.qualityScore).toBe(80);
  });

  it("honors abort before fetch and during body streaming without publishing evidence", async () => {
    const opts = await setup();
    await expect(readDirectDefuddlePage({ url, scope, signal: AbortSignal.abort() }, opts)).rejects.toThrow();
    expect(opts.fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ pull(stream) { controller.abort(); stream.enqueue(new TextEncoder().encode(html)); } }), { headers: { "content-type": "text/html" } }));
    await expect(readDirectDefuddlePage({ url, scope, signal: controller.signal }, { root: opts.root, fetcher })).rejects.toThrow();
    expect(await readdir(opts.root)).toEqual([]);
  });

  it("uses a 15-second retrieval deadline and rejects a stalled fetch on deadline without saving evidence", async () => {
    const opts = await setup();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
      const pending = readDirectDefuddlePage({ url, scope }, { root: opts.root, fetcher });
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      deadline.abort(new DOMException("Deadline reached", "TimeoutError"));
      await expect(pending).rejects.toThrow("time budget");
      expect(await readdir(opts.root)).toEqual([]);
    } finally { timeout.mockRestore(); }
  });

  it("reports only a verified matching direct response URL and keeps short text quality below scientific completeness", async () => {
    const opts = await setup();
    const fetcher = vi.fn(async () => {
      const response = new Response("<html><head><title>Small article</title></head><body><article><p>A brief real limitation.</p></article></body></html>", { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    });
    const first = await readDirectDefuddlePage({ url, scope }, { root: opts.root, fetcher });
    expect(first).toMatchObject({ finalUrl: url, finalUrlVerified: true, qualityScore: 40, nextOffset: null });
    expect(first.warnings).toContain("short_content_check_completeness");
    const continuation = await readJinaDefuddlePage({ url, scope, evidenceId: first.evidenceId }, { root: opts.root, fetcher });
    expect(continuation.finalUrlVerified).toBe(true);
    expect(continuation.provider).toBe("direct_http");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicitly non-HTML response and cancellation of a saved continuation without another fetch", async () => {
    const opts = await setup();
    const wrongType = vi.fn(async () => new Response(html, { headers: { "content-type": "application/json" } }));
    await expect(readDirectDefuddlePage({ url, scope }, { root: opts.root, fetcher: wrongType })).rejects.toThrow("not HTML");
    expect(await readdir(opts.root)).toEqual([]);
    const first = await readDirectDefuddlePage({ url, scope, maxChars: 300 }, opts);
    await expect(readDirectDefuddlePage({ url, scope, evidenceId: first.evidenceId, offset: first.nextOffset!, signal: AbortSignal.abort() }, opts)).rejects.toThrow();
    await expect(readDirectDefuddlePage({ url, scope, evidenceId: "-".repeat(36) }, opts)).rejects.toThrow("Invalid");
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["raw.html", "clean.md", "snapshot.json", "window-0-16000.json"])("rejects partial persistence when %s cannot be written", async file => {
    const opts = await setup(); faults.file = file;
    await expect(readDirectDefuddlePage({ url, scope }, opts)).rejects.toThrow("persistence");
    const directories = await readdir(join(opts.root, createHash("sha256").update(scope).digest("hex")));
    expect(directories).toHaveLength(1);
    const files = await readdir(join(opts.root, createHash("sha256").update(scope).digest("hex"), directories[0]));
    expect(files).not.toContain("window-0-16000.json");
    if (file !== "window-0-16000.json") expect(files).not.toContain("snapshot.json");
  });

  it("rejects cancellation between raw and clean persistence", async () => {
    const opts = await setup(); faults.controller = new AbortController(); faults.abortAfter = "raw.html";
    await expect(readDirectDefuddlePage({ url, scope, signal: faults.controller.signal }, opts)).rejects.toThrow();
    const directory = join(opts.root, createHash("sha256").update(scope).digest("hex"));
    const ids = await readdir(directory);
    expect(await readdir(join(directory, ids[0]))).toEqual(["raw.html"]);
  });
});
