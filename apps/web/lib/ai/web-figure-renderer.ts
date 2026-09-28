import { parseHTML } from "linkedom";
import sharp from "sharp";
import { readPublicImage } from "./public-page-reader";
import type { WebFigure } from "./web-figures";

let rendering = false;
/** No browser visits the source URL: only the saved fragment is rendered, offline. */
export async function renderWebFigure(figure: WebFigure, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (figure.kind === "canvas") throw Error("Canvas pixels were not captured in HTML; original-page screenshot required.");
  if (figure.kind === "image") {
    if (!figure.sourceUrl) throw Error("Image source unavailable");
    let source: { bytes: Buffer; finalUrl: string };
    const embedded = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(figure.sourceUrl);
    if (embedded) {
      if (embedded[2].length > 7 * 1024 * 1024) throw Error("Embedded image exceeds budget");
      source = { bytes: Buffer.from(embedded[2], "base64"), finalUrl: "embedded_in_saved_html" };
    } else source = await readPublicImage({ url: figure.sourceUrl, signal });
    const bytes = await sharp(source.bytes, { limitInputPixels: 20_000_000 }).rotate().resize({ width: 1600, height: 2200, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    signal?.throwIfAborted();
    return { bytes, warnings: ["image_pixels_fetched_on_demand_may_postdate_html"], finalUrl: source.finalUrl };
  }
  if (rendering) throw Error("Figure renderer busy; retry after the current render completes.");
  if (Buffer.byteLength(figure.markup) > 512_000) throw Error("SVG exceeds render budget");
  rendering = true;
  let browser: import("playwright").Browser | undefined;
  const abort = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, timeout: 15000,
      ...(process.env.WEB_FIGURE_BROWSER_PATH ? { executablePath: process.env.WEB_FIGURE_BROWSER_PATH } : process.platform === "win32" ? { channel: "msedge" } : {}) });
    signal?.throwIfAborted();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport: { width: 1600, height: 2200 }, deviceScaleFactor: 1 });
    let blockedRequests = 0;
    await context.route("**/*", route => { blockedRequests++; return route.abort(); });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const { document } = parseHTML(`<html><body>${figure.markup}</body></html>`);
    document.querySelectorAll("script,iframe,object,embed,link,base,meta,form,animate,animateMotion,animateTransform,set").forEach(node => node.remove());
    for (const element of Array.from(document.querySelectorAll("*"))) {
      for (const attr of Array.from(element.attributes)) {
        if (/^on/i.test(attr.name) || (/^(href|xlink:href|src)$/i.test(attr.name) && !attr.value.startsWith("#"))) element.removeAttribute(attr.name);
      }
    }
    const svg = document.querySelector("svg");
    if (!svg) throw Error("Saved SVG unavailable");
    const box = svg.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
    const width = box?.[2] || parseFloat(svg.getAttribute("width") || "") || 1200;
    const height = box?.[3] || parseFloat(svg.getAttribute("height") || "") || 800;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw Error("Invalid SVG dimensions");
    const scale = Math.min(1400 / width, 2000 / height, 2);
    svg.setAttribute("width", String(Math.ceil(width * scale)));
    svg.setAttribute("height", String(Math.ceil(height * scale)));
    svg.setAttribute("style", "display:block;max-width:none;background:white");
    await page.setContent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"></head><body style="margin:0;background:white">${svg.outerHTML}</body></html>`, { waitUntil: "load" });
    const bytes = await page.locator("svg").first().screenshot({ type: "png", animations: "disabled", timeout: 10000 });
    signal?.throwIfAborted();
    return { bytes, warnings: ["offline_svg_render_external_styles_fonts_and_resources_unavailable", ...(blockedRequests ? ["external_resource_requests_blocked"] : [])], finalUrl: null };
  } finally {
    signal?.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
    rendering = false;
  }
}
