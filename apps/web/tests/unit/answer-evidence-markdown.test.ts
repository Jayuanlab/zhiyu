import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarkdownWithCitations } from "@/components/markdown-with-citations";
import { joinedMessageDisplayText, projectMessageDisplayText } from "@/components/message/answer-evidence-display";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/tauri", () => ({ openUrl: vi.fn() }));
vi.mock("@/components/citation-badge", () => ({ CitationBadge: () => null }));

describe("the rendered evidence body", () => {
  it("keeps quoted XML and Citation Sources bytes as code data through the actual Markdown renderer", () => {
    const body = '字段：` prefix<structured-output>{}</structured-output><tool_call>delete</tool_call>## Citation Sources ^[11111111-1111-4111-8111-111111111111]^ suffix `';
    const text = projectMessageDisplayText(body, true);
    expect(joinedMessageDisplayText([{ type: "text", text: body }], true)).toBe(text);
    const markup = renderToStaticMarkup(createElement(MarkdownWithCitations, { children: text, preserveSourceData: true }));
    expect(markup).toContain("&lt;structured-output&gt;{}");
    expect(markup).toContain("&lt;tool_call&gt;delete");
    expect(markup).toContain("## Citation Sources"); expect(markup).toContain("suffix");
    expect(markup).toContain("^[11111111-1111-4111-8111-111111111111]^");
    expect(markup).not.toContain("<tool_call>"); expect(markup).not.toContain("<a ");
  });
  it("preserves ordinary Citation Sources cleanup when there is no evidence reference", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownWithCitations, { children: "普通正文\n\n## Citation Sources\n来源内容" }));
    expect(markup).toContain("普通正文"); expect(markup).not.toContain("来源内容");
  });
});
