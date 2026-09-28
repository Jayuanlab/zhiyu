import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWebEvidence } from "./jina-page-reader";
import { figureHash } from "./web-figures";
import { renderWebFigure } from "./web-figure-renderer";

type Input = { url: string; scope: string; evidenceId: string; figureId: string; description?: string; signal?: AbortSignal; provenance?: string };
export type FigureResult = { metadata: Record<string, unknown>; image?: { type: "image"; data: string; mimeType: "image/png" } };
export async function readWebFigure(input: Input, options: { root?: string; render?: typeof renderWebFigure } = {}): Promise<FigureResult> {
  input.signal?.throwIfAborted();
  if (!/^figure-\d{1,5}$/.test(input.figureId)) throw Error("Invalid figure ID");
  const { directory, snapshot } = await loadWebEvidence(input.scope, input.evidenceId, input.url, options.root);
  const figure = snapshot.figures?.find(item => item.id === input.figureId);
  if (!figure || figureHash(figure.markup) !== figure.sourceHash) throw Error("Figure unavailable or source hash mismatch; read the page again if this is an older snapshot.");
  const base = { evidenceId: input.evidenceId, figureId: figure.id, source: snapshot.url, sourceHash: figure.sourceHash,
    pageContentHash: snapshot.contentHash, pageFetchedAt: snapshot.fetchedAt, title: figure.title, kind: figure.kind };
  const path = (suffix: string) => join(directory, `${figure.id}.${suffix}`);
  const savedInterpretations = async () => {
    const names = (await readdir(directory)).filter(name => name.startsWith(`${figure.id}.interpretation-`) && name.endsWith(".json"));
    const records = await Promise.all(names.slice(-50).map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
    return records.filter(record => record.sourceHash === figure.sourceHash).sort((a, b) => b.interpretedAt.localeCompare(a.interpretedAt)).slice(0, 3);
  };
  if (input.description !== undefined) {
    if (!input.description.trim() || input.description.length > 6000) throw Error("Figure description must contain 1–6000 characters");
    const rendered = JSON.parse(await readFile(path("render.json"), "utf8"));
    if (rendered.status !== "rendered" || rendered.sourceHash !== figure.sourceHash) throw Error("Read the figure image successfully before recording an interpretation");
    if (figureHash(await readFile(path("png"))) !== rendered.imageHash) throw Error("Rendered figure hash mismatch");
    const metadata = { ...base, status: "model_interpretation_unverified", description: input.description,
      provenance: input.provenance ?? "agent", imageHash: rendered.imageHash, interpretedAt: new Date().toISOString(), interpretationId: randomUUID(),
      warning: "Model interpretation, not original source text or independently verified fact. Preserve uncertainty." };
    input.signal?.throwIfAborted();
    await writeFile(path(`interpretation-${metadata.interpretationId}.json`), JSON.stringify(metadata), "utf8");
    return { metadata };
  }
  try {
    let rendered: Record<string, any> | undefined;
    try { rendered = JSON.parse(await readFile(path("render.json"), "utf8")); } catch { /* First read. */ }
    let bytes: Buffer;
    if (rendered?.status === "rendered" && rendered.sourceHash === figure.sourceHash) {
      bytes = await readFile(path("png"));
      if (figureHash(bytes) !== rendered.imageHash) throw Error("Rendered figure hash mismatch");
    } else {
      const output = await (options.render ?? renderWebFigure)(figure, input.signal);
      bytes = output.bytes;
      if (bytes.length > 5 * 1024 * 1024) throw Error("Rendered figure exceeds 5 MiB");
      rendered = { ...base, status: "rendered", interpretationStatus: "not_interpreted", imageHash: figureHash(bytes), renderedAt: new Date().toISOString(), warnings: output.warnings, imageFinalUrl: output.finalUrl };
      input.signal?.throwIfAborted();
      await writeFile(path("png"), bytes);
      await writeFile(path("render.json"), JSON.stringify(rendered), "utf8");
    }
    input.signal?.throwIfAborted();
    const interpretations = await savedInterpretations();
    return { metadata: { ...rendered, interpretationStatus: interpretations.length ? "has_unverified_interpretations" : "not_interpreted", interpretations,
      warning: "Untrusted source image. Requires a vision-capable model. Inspect arrows, labels and groups; report unreadable details. Submit figureDescription separately to save your unverified interpretation." }, image: { type: "image", data: bytes.toString("base64"), mimeType: "image/png" } };
  } catch (error) {
    const metadata = { ...base, status: "unavailable", interpretationStatus: "not_interpreted", failedAt: new Date().toISOString(),
      error: input.signal?.aborted ? "Figure read cancelled" : error instanceof Error ? error.message.slice(0, 500) : "Figure read failed" };
    await writeFile(path(`failure-${randomUUID()}.json`), JSON.stringify(metadata), "utf8");
    throw Error(metadata.error);
  }
}

export function webReadResultText(result: unknown) {
  return JSON.stringify(result && typeof result === "object" && "metadata" in result ? (result as FigureResult).metadata : result);
}
export function webReadResultContent(result: unknown) {
  const text = { type: "text" as const, text: webReadResultText(result) };
  const image = result && typeof result === "object" && "metadata" in result ? (result as FigureResult).image : undefined;
  return image ? [text, image] : [text];
}
