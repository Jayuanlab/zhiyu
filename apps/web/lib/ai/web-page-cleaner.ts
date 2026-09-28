import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { extractWebFigures } from "./web-figures";

export const WEB_CLEANER_VERSION = "defuddle-0.19.4/zhiyu-2";

/** Parse inert HTML only. No scripts, subresources or extractor network calls. */
export async function cleanWebPage(html: string, url: string) {
  if (!/<(?:html|body|article|main|div|p|h[1-6])(?:\s|>)/i.test(html)) {
    throw new Error("Reader did not return HTML; refusing to treat Markdown/error text as HTML.");
  }
  const { document } = parseHTML(html);
  const warnings: string[] = [];
  // Defuddle preserves SVG markup. Keep its labels without sending paths to the model.
  const candidates = extractWebFigures(document as unknown as Document, url);
  if (candidates.length) warnings.push("figures_require_on_demand_visual_read");
  const result = await Defuddle(document as unknown as Document, url, {
    markdown: true,
    useAsync: false,
    includeReplies: false,
    fetch: async () => { throw new Error("Extractor network access disabled"); },
  });
  let content = result.content.trim();
  const figures = candidates.filter(figure => content.includes(`WebFigure ${figure.id}]`) || content.includes(`WebFigure ${figure.id}\\]`));
  figures.forEach((figure, index) => {
    const id = `figure-${index + 1}`;
    content = content.replaceAll(`WebFigure ${figure.id}\\]`, `WebFigure ${id}\\]`).replaceAll(`WebFigure ${figure.id}]`, `WebFigure ${id}]`);
    figure.id = id;
  });
  if (!content) throw new Error("Defuddle returned no readable content.");
  const title = result.title || "";
  if (/^(just a moment|access denied|attention required|sign in|log in|登录|安全验证)[.!\s|_-]*$/i.test(title.trim())) {
    throw new Error("Reader returned a login or challenge page, not article evidence.");
  }
  if (content.length < 200) warnings.push("short_content_check_completeness");
  return { content, title: title.slice(0, 500), author: result.author?.slice(0, 300) || null, publishedAt: result.published?.slice(0, 100) || null,
    cleaner: WEB_CLEANER_VERSION, warnings, diagramCount: figures.length, figures };
}
