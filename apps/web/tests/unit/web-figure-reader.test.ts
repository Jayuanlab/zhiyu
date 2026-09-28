import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJinaDefuddlePage, webEvidenceDirectory } from "@/lib/ai/jina-page-reader";
import { readWebFigure, webReadResultContent, webReadResultText } from "@/lib/ai/web-figure-reader";
import { readPublicImage } from "@/lib/ai/public-page-reader";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { Type } from "@earendil-works/pi-ai";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const html = `<html><head><title>Diagram</title></head><body><nav><svg><text>Navigation</text></svg></nav><article><h1>Diagram</h1><p>${"Article evidence. ".repeat(50)}</p><svg style="display: none"><path d="M0 0"/></svg><svg viewBox="0 0 200 100"><text>Q</text><text>K</text><path d="M10 10 L100 10"/></svg><p>Conclusion.</p></article></body></html>`;
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zhiyu-figure-test-")); roots.push(root);
  const page = await readJinaDefuddlePage({ url: "https://example.com/article", scope: "user:A" }, { root, fetcher: async () => new Response(html) });
  const input = { url: page.url, scope: "user:A", evidenceId: page.evidenceId, figureId: page.figures[0].id };
  const render = vi.fn(async () => ({ bytes: Buffer.from("fixture-png"), warnings: [], finalUrl: null }));
  return { root, page, input, render, directory: webEvidenceDirectory(input.scope, input.evidenceId, root) };
}
describe("on-demand web figures", () => {
  it("only exposes retained article figures without SVG source in model text", async () => {
    const { page } = await setup();
    expect(page.figures).toHaveLength(1);
    expect(page.figures[0]).toMatchObject({ id: "figure-1", status: "not_interpreted" });
    expect(page.content).toContain("WebFigure figure-1");
    expect(JSON.stringify(page)).not.toContain("<path");
  });
  it("caches rendered pixels and keeps source, image, and unverified interpretation separate", async () => {
    const { input, root, render, directory } = await setup();
    await expect(readWebFigure({ ...input, description: "Q flows to K" }, { root, render })).rejects.toThrow();
    const first = await readWebFigure(input, { root, render });
    expect(first.image?.type).toBe("image");
    const rawBefore = await readFile(join(directory, "raw.html"), "utf8");
    const saved = await readWebFigure({ ...input, description: "Observed labels Q and K; arrow direction uncertain.", provenance: "test-model" }, { root, render });
    expect(saved.metadata.status).toBe("model_interpretation_unverified");
    const again = await readWebFigure(input, { root, render });
    expect(again.metadata.interpretationStatus).toBe("has_unverified_interpretations");
    expect(again.image).toEqual(first.image);
    expect(render).toHaveBeenCalledOnce();
    const refreshed = await readJinaDefuddlePage({ url: input.url, scope: input.scope, evidenceId: input.evidenceId }, { root, fetcher: async () => { throw Error("Must not refetch"); } });
    expect(refreshed.figures[0]).toMatchObject({ status: "has_unverified_interpretations", renderStatus: "rendered" });
    expect(await readFile(join(directory, "raw.html"), "utf8")).toBe(rawBefore);
    expect((await readdir(directory)).some(name => name.includes("interpretation-"))).toBe(true);
  });
  it("blocks cross-scope, wrong URL, traversal, and cancelled reads before rendering", async () => {
    const { input, root, render } = await setup();
    for (const changes of [{ scope: "user:B" }, { url: "https://example.com/other" }, { figureId: "../raw" }, { signal: AbortSignal.abort() }]) {
      await expect(readWebFigure({ ...input, ...changes }, { root, render })).rejects.toThrow();
    }
    expect(render).not.toHaveBeenCalled();
  });
  it("records render failures without marking the figure interpreted", async () => {
    const { input, root, directory } = await setup();
    await expect(readWebFigure(input, { root, render: async () => { throw Error("Browser unavailable"); } })).rejects.toThrow("Browser unavailable");
    const failure = (await readdir(directory)).find(name => name.includes("failure-"))!;
    expect(JSON.parse(await readFile(join(directory, failure), "utf8"))).toMatchObject({ status: "unavailable", interpretationStatus: "not_interpreted" });
  });
  it("returns actual image blocks through guarded Pi tools, keeping base64 out of text budgets", async () => {
    const { input, root, render } = await setup();
    const tool = createGuardedPiTool({ name: "webReadPage", description: "Read", parameters: Type.Object({}),
      execute: () => readWebFigure(input, { root, render }), formatResult: webReadResultText, formatContent: webReadResultContent });
    const result = await tool.execute("figure", {});
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((result.content[0] as { text: string }).text).not.toContain(Buffer.from("fixture-png").toString("base64"));
  });
  it("rejects private image redirects and oversized image downloads", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } }));
    await expect(readPublicImage({ url: "https://example.com/a.png" }, redirect)).rejects.toThrow("public");
    expect(redirect).toHaveBeenCalledOnce();
    const large = vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }));
    await expect(readPublicImage({ url: "https://example.com/a.png" }, large)).rejects.toThrow("5 MiB");
  });
});
