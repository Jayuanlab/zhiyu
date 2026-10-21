import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebEvidence, readDirectDefuddlePage, readJinaDefuddlePage } from "@/lib/ai/jina-page-reader";
import { readWithWebFallback } from "@/lib/workshops/web-fetch";
import { isSavedResearchPageMethod } from "@/lib/workshops/research-page-method";

const roots: string[] = [];
const url = "https://example.com/rfc2119.txt", scope = "workshop:plain-source";
const text = "\uFEFFRFC 2119\r\nMUST means an absolute requirement.\r\n".repeat(40) + "TAIL SOURCE";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (relative(tmpdir(), root).startsWith("..")) throw Error("Unexpected temporary evidence path");
    await rm(root, { recursive: true, force: true });
  }
});
async function setup(body: BodyInit = text, contentType = "text/plain; charset=utf-8") {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-direct-text-")); roots.push(root);
  const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": contentType } }));
  return { root, fetcher };
}

describe("immutable public plain-text source fallback", () => {
  it('resolves an exact owned snapshot without a copied URL and never refetches a missing ID',async()=>{
    const opts=await setup();const first=await readDirectDefuddlePage({url,scope,maxChars:350},opts);
    const owned=await loadWebEvidence(scope,first.evidenceId,undefined,opts.root);
    expect(owned.snapshot.url).toBe(url);expect(first.nextRead).toMatchObject({url,evidenceId:first.evidenceId,offset:350});
    await expect(loadWebEvidence('workshop:other',first.evidenceId,undefined,opts.root)).rejects.toThrow('unavailable');
    expect(opts.fetcher).toHaveBeenCalledOnce();
  });
  it("preserves real source bytes, scope, full-body hash and exact windows after a Jina failure", async () => {
    const opts = await setup(), errors: string[] = [];
    const jina = vi.fn(async () => new Response("unavailable", { status: 403 }));
    const first = await readWithWebFallback(
      () => readJinaDefuddlePage({ url, scope, maxChars: 350 }, { root: opts.root, fetcher: jina }),
      () => readDirectDefuddlePage({ url, scope, maxChars: 350 }, opts), errors);
    expect(errors).toEqual(["Jina Reader HTTP 403"]);
    expect(first).toMatchObject({ provider: "direct_http", method: "direct_text", cleaner: "plain-text-utf8/zhiyu-1",
      contentType: "text/plain", offset: 0, totalChars: text.length, contentHash: hash(text), rawHash: hash(text), rawBytes: Buffer.byteLength(text) });
    expect(first.content).toBe(text.slice(0, 350));
    expect(first.warnings).toContain("direct_http_fallback_plain_text");
    expect(first.warning).toContain("Defuddle were not used");
    expect(isSavedResearchPageMethod(first)).toBe(true);
    const saved = await loadWebEvidence(scope, first.evidenceId, url, opts.root);
    expect(await readFile(join(saved.directory, "raw.html"), "utf8")).toBe(text);
    expect(await readFile(join(saved.directory, "clean.md"), "utf8")).toBe(text);
    expect(saved.snapshot.scopeHash).toBe(hash(scope));
    const rest = await readJinaDefuddlePage({ url, scope, evidenceId: first.evidenceId, offset: first.nextOffset!, maxChars: 30_000 }, opts);
    expect(first.content + rest.content).toBe(text);
    expect(rest).toMatchObject({ method: "direct_text", contentHash: first.contentHash, nextOffset: null, totalChars: text.length });
    expect(opts.fetcher).toHaveBeenCalledTimes(1);
    expect(jina).toHaveBeenCalledTimes(1);
    await expect(readDirectDefuddlePage({ url, scope: "workshop:other", evidenceId: first.evidenceId }, opts)).rejects.toThrow();
    await expect(readDirectDefuddlePage({ url: "https://example.com/other.txt", scope, evidenceId: first.evidenceId }, opts)).rejects.toThrow("mismatch");
  });
  it.each(["application/pdf", "application/json", "image/png"])("refuses unsupported %s before saving evidence", async type => {
    const opts = await setup(text, type);
    await expect(readDirectDefuddlePage({ url, scope }, opts)).rejects.toThrow("not HTML");
    expect(await readdir(opts.root)).toEqual([]);
  });
  it("rejects oversized, binary and non-UTF-8 plaintext without committing a snapshot", async () => {
    for (const [body, type] of [["x".repeat(2 * 1024 * 1024 + 1), "text/plain"], ["text\u0000binary", "text/plain"],
      [new Uint8Array([0xff, 0xfe, 0xff]), "text/plain; charset=utf-8"], ["text", "text/plain; charset=iso-8859-1"]] as const) {
      const opts = await setup(body, type);
      await expect(readDirectDefuddlePage({ url, scope }, opts)).rejects.toThrow();
      expect(await readdir(opts.root)).toEqual([]);
    }
  });
  it("does not register an unsaved legacy direct extraction or mislabeled plaintext as research evidence", () => {
    expect(isSavedResearchPageMethod({ method: "direct_fetch", provider: "direct_http", cleaner: "plain-text-utf8/zhiyu-1" })).toBe(false);
    expect(isSavedResearchPageMethod({ method: "direct_text", provider: "direct_http", cleaner: "defuddle-0.19.4/zhiyu-2", warnings: ["direct_http_fallback_plain_text"] })).toBe(false);
    expect(isSavedResearchPageMethod({ method: "direct_text", provider: "direct_http", cleaner: "plain-text-utf8/zhiyu-1", warnings: [] })).toBe(false);
  });
});
