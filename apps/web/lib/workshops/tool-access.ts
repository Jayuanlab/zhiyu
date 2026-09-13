import type { Workshop } from "@/lib/db/schema";
import { WORKSHOP_TOOLS } from "@/lib/agent-tools/registry";

const HARNESS_QUALITY_ROLE = "harness_quality_steward";
const HARNESS_QUALITY_BUILTINS = new Set(["skill"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function leafToolName(toolName: string) {
  return (toolName.split("__").pop() ?? toolName).toLowerCase();
}

export function isHarnessQualityWork(workshop: Pick<Workshop, "modelConfig">) {
  const config = asRecord(workshop.modelConfig);
  return config.role === HARNESS_QUALITY_ROLE;
}

export function resolveWorkshopSdkAllowedTools(
  workshop: Pick<Workshop, "modelConfig">,
  baseTools: readonly string[],
) {
  const config = asRecord(workshop.modelConfig);
  const denied = new Set(
    stringArray(config.disallowedTools).map(leafToolName),
  );
  const uniqueTools = Array.from(new Set(baseTools));
  const deniedFiltered = uniqueTools.filter(
    (tool) => !denied.has(leafToolName(tool)) && !WORKSHOP_TOOLS.find((descriptor) => leafToolName(descriptor.name) === leafToolName(tool))?.deniedWorkRoles?.includes(String(config.role ?? config.persona ?? "")),
  );

  if (!isHarnessQualityWork(workshop)) return deniedFiltered;

  const configured = new Set(
    stringArray(config.allowedTools).map(leafToolName),
  );
  return deniedFiltered.filter((tool) => {
    const leaf = leafToolName(tool);
    return configured.has(leaf) || HARNESS_QUALITY_BUILTINS.has(leaf);
  });
}
