import { XMLParser } from "fast-xml-parser";

/** Convert a public RSS index into dated, citable entries instead of flattened XML. */
export function rssToReadableText(xml: string): string {
  const channel = new XMLParser({ ignoreAttributes: true, processEntities: true }).parse(xml)?.rss?.channel;
  if (!channel) throw new Error("Official RSS returned an invalid feed");
  const text = (value: unknown) => typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
  const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const entries = items.slice(0, 40).map((item: Record<string, unknown>) => {
    const title = text(item.title);
    const link = text(item.link);
    if (!title || !/^https?:\/\//i.test(link)) return "";
    return `## ${title}\nURL: ${link}\nPublished: ${text(item.pubDate) || "unknown"}\n${text(item.description)}`;
  }).filter(Boolean);
  if (!entries.length) throw new Error("Official RSS returned no usable entries");
  return `# ${text(channel.title) || "Official news feed"}\n\n${entries.join("\n\n")}`;
}
