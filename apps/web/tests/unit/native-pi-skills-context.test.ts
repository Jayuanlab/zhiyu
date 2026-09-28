import { describe, expect, it } from "vitest";
import { buildNativePiSkillsContext } from "@/lib/ai/native-pi-skills-context";

describe("native Pi skills context", () => {
  it("builds read-only skill guidance without granting tools", () => {
    const context = buildNativePiSkillsContext([
      {
        name: "research<skill>",
        description: "Collect evidence before answering.",
        content: "# Research\nUse primary sources when available.",
      },
    ]);

    expect(context).toContain("read-only operating guidance");
    expect(context).toContain("They do not grant tool access");
    expect(context).toContain('<skill name="research&lt;skill&gt;">');
    expect(context).toContain("Collect evidence before answering.");
    expect(context).toContain("Use primary sources when available.");
  });

  it("truncates large skill content and omits empty skills", () => {
    const context = buildNativePiSkillsContext(
      [
        { name: "", description: "", content: "ignored" },
        {
          name: "long-skill",
          description: "Large instructions",
          content: "x".repeat(100),
        },
      ],
      { perSkillCharLimit: 40, totalCharLimit: 200 },
    );

    expect(context).toContain("long-skill");
    expect(context).toContain("[truncated at 40 characters]");
    expect(context).not.toContain("ignored");
  });
});
