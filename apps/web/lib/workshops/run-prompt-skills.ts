import { getSkillContent, loadSkills } from "@/lib/ai/skills/loader";
import { join } from "node:path";
import { resolveWorkshopRunSkillSelections, type WorkshopPromptSource, type WorkshopRunSkill } from "./run-prompt";

/** Read-only skill loading: only an explicitly mapped Loop method is mandatory and preloaded in full. */
export function loadWorkshopRunSkills(workshop: WorkshopPromptSource | null, loopName?: string): WorkshopRunSkill[] {
  const selected = resolveWorkshopRunSkillSelections(workshop, loopName);
  if (selected.length === 0) return [];
  const available = loadSkills();
  return selected.map(selection => {
    const skill = available.find(item => item.name === selection.name);
    const content = skill && selection.required ? getSkillContent(skill.path) : null;
    return {
      ...selection, description: skill?.description,
      source: skill ? join(skill.path, "SKILL.md") : null, version: skill?.version ?? null,
      content, status: !skill ? "unavailable" : selection.required ? content?.trim() ? "loaded" : "unavailable" : "available",
    };
  });
}
