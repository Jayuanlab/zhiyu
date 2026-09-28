export interface NativePiSkillContext {
  name: string;
  description: string;
  content?: string | null;
}

export const NATIVE_PI_SKILL_CONTEXT_TOTAL_CHAR_LIMIT = 16000;
export const NATIVE_PI_SKILL_CONTEXT_PER_SKILL_CHAR_LIMIT = 3000;

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 42)).trimEnd()}\n[truncated at ${limit} characters]`;
}

function escapeSkillName(value: string): string {
  return value.replace(/[<>"&]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "&":
        return "&amp;";
      default:
        return char;
    }
  });
}

export function buildNativePiSkillsContext(
  skills: NativePiSkillContext[],
  options: {
    totalCharLimit?: number;
    perSkillCharLimit?: number;
  } = {},
): string {
  const totalCharLimit =
    options.totalCharLimit ?? NATIVE_PI_SKILL_CONTEXT_TOTAL_CHAR_LIMIT;
  const perSkillCharLimit =
    options.perSkillCharLimit ?? NATIVE_PI_SKILL_CONTEXT_PER_SKILL_CHAR_LIMIT;

  const parts = skills
    .filter((skill) => skill.name.trim() || skill.description.trim())
    .map((skill) => {
      const name = escapeSkillName(skill.name.trim() || "unnamed-skill");
      const description = skill.description.trim();
      const content = truncateText((skill.content ?? "").trim(), perSkillCharLimit);

      return [
        `<skill name="${name}">`,
        description ? `Description: ${description}` : "",
        content ? `Instructions:\n${content}` : "",
        "</skill>",
      ]
        .filter(Boolean)
        .join("\n");
    });

  if (parts.length === 0) return "";

  const body = truncateText(parts.join("\n\n"), totalCharLimit);
  return `[System Note: The following enabled skills are available to Pi as read-only operating guidance. They do not grant tool access, shell access, MCP access, filesystem write access, or permission to perform external actions. Use them only when relevant to the user's request and stay within the host application's explicit capabilities.\n\n${body}\n]\n\n`;
}
