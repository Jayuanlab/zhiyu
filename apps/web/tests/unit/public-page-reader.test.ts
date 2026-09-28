import { describe, expect, it, vi } from "vitest";
import { isPublicPageAddress, readPublicPage, validatePublicPageUrl } from "@/lib/ai/public-page-reader";
describe("public evidence reader", () => {
  it("rejects local/private/link-local addresses, credential URLs and alternate ports", () => {
    for (const value of ["http://127.0.0.1", "http://2130706433", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://10.0.0.1", "http://169.254.169.254", "http://100.64.0.1", "http://localhost", "https://foo.local", "https://user:secret@example.com", "http://example.com:5432", "file:///private"]) expect(() => validatePublicPageUrl(value)).toThrow();
    expect(isPublicPageAddress("192.168.1.1")).toBe(false);
    expect(isPublicPageAddress("fc00::1")).toBe(false);
    expect(isPublicPageAddress("2002:7f00:1::1")).toBe(false);
    expect(isPublicPageAddress("8.8.8.8")).toBe(true);
    expect(validatePublicPageUrl("https://docs.python.org/3/").hostname).toBe("docs.python.org");
  });
  it("refuses a public URL redirecting into the private network", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
    await expect(readPublicPage({ url: "https://example.com" }, fetcher)).rejects.toThrow("public");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("returns citable text, bounds content and identifies clipping", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(`<title>Public</title><script>evil()</script><p>${"evidence ".repeat(4000)}</p>`, { headers: { "content-type": "text/html" } }));
    const result = await readPublicPage({ url: "https://example.com" }, fetcher);
    expect(result).toMatchObject({ title: "Public", provider: "direct_public_page", truncated: true });
    expect(result.content).not.toContain("evil");
    expect(result.content.length).toBeLessThanOrEqual(16000);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
  it("reports HTTP errors instead of passing an error page as evidence", async () => {
    await expect(readPublicPage({ url: "https://example.com" }, async () => new Response("blocked", { status: 403 }))).rejects.toThrow("403");
  });
  it("reads the requested section instead of repeatedly returning a truncated page prefix", async () => {
    const result = await readPublicPage({ url: "https://example.com/doc#dictionary" }, async () => new Response(`<p>${"unrelated ".repeat(4000)}</p><section id="dictionary"><h2>Dictionary</h2><p>Key value evidence</p></section>`, { headers: { "content-type": "text/html" } }));
    expect(result.fragmentFound).toBe(true);
    expect(result.content).toContain("Key value evidence");
    expect(result.content).not.toContain("unrelated");
  });
});
