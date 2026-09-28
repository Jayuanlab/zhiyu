import { createHash } from "node:crypto";
import type { HTMLElement } from "linkedom";

export type WebFigure = {
  id: string; kind: "svg" | "image" | "canvas"; title: string;
  labels: string; sourceHash: string; markup: string; sourceUrl?: string;
};
export const figureHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Preserve immutable source separately; put small, addressable markers in the article. */
export function extractWebFigures(document: Document, url: string): WebFigure[] {
  const figures: WebFigure[] = [];
  let heading = "";
  for (const node of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,svg,img,canvas"))) {
    if (/^H[1-6]$/i.test(node.tagName)) { heading = node.textContent?.trim() ?? ""; continue; }
    if (!node.isConnected || node.parentElement?.closest("svg")) continue;
    if (node.closest("nav,header,footer,script,style")) continue;
    if (node.hasAttribute("hidden") || /display\s*:\s*none/i.test(node.getAttribute("style") ?? "")) continue;
    const kind = node.tagName.toLowerCase() === "svg" ? "svg" : node.tagName.toLowerCase() === "canvas" ? "canvas" : "image";
    const width = Number(node.getAttribute("width"));
    const height = Number(node.getAttribute("height"));
    if (node.getAttribute("aria-hidden") === "true" || (width > 0 && height > 0 && width <= 48 && height <= 48)) continue;
    const id = `figure-${figures.length + 1}`;
    const title = (node.closest("figure")?.querySelector("figcaption")?.textContent || node.getAttribute("alt") || node.querySelector("title")?.textContent || heading || id).replace(/\s+/g, " ").trim().slice(0, 300);
    const labels = Array.from(node.querySelectorAll("title,desc,text,foreignObject")).map(n => n.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ").slice(0, 1500);
    const markup = node.outerHTML;
    let sourceUrl: string | undefined;
    if (kind === "image") {
      try { const src = node.getAttribute("data-src") || node.getAttribute("src"); if (src) sourceUrl = new URL(src, url).toString(); } catch { /* Remains explicitly unreadable. */ }
    }
    figures.push({ id, kind, title, labels, markup, sourceHash: figureHash(markup), sourceUrl });
    const marker = document.createElement("p");
    marker.textContent = `[WebFigure ${id}] ${title}. Visual relationships not yet interpreted; read with evidenceId and figureId. ${labels}`;
    (node as unknown as HTMLElement).replaceWith(marker as never);
  }
  return figures;
}

export function publicFigure(figure: WebFigure) {
  const { markup: _markup, sourceUrl, ...metadata } = figure;
  return { ...metadata, sourceUrl: sourceUrl?.startsWith("data:") ? "embedded_in_saved_html" : sourceUrl, status: "not_interpreted" as const };
}
