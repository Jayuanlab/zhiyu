import type { Workshop } from "@/lib/db/schema";
import { WORKSHOP_TOOLS } from "@/lib/agent-tools/registry";
import { toolLeafName as leafToolName } from "@/lib/agent-tools/tool-name";

const HARNESS_QUALITY_ROLE = "harness_quality_steward";
const HARNESS_QUALITY_BUILTINS = new Set<string>();

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

function hasConfiguredSkills(config: Record<string, unknown>) {
  return (
    stringArray(config.primarySkills).length > 0 ||
    Object.values(asRecord(config.loopSkillMap)).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  );
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
  const skillConfigured = hasConfiguredSkills(config);
  const deniedFiltered = uniqueTools.filter(
    (tool) => !denied.has(leafToolName(tool)) && !WORKSHOP_TOOLS.find((descriptor) => leafToolName(descriptor.name) === leafToolName(tool))?.deniedWorkRoles?.includes(String(config.role ?? config.persona ?? "")),
  ).filter(
    (tool) => skillConfigured || leafToolName(tool) !== "skill",
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

/** Pi exposes only registered domain capabilities, narrowed by Work policy. */
export function resolveWorkshopPiAllowedTools(
  workshop: Pick<Workshop, "modelConfig" | "boundaryPolicy">,
  registeredTools: readonly string[],
  requestedTools: readonly string[] = registeredTools,
) {
  const config = asRecord(workshop.modelConfig);
  const boundary = asRecord(workshop.boundaryPolicy);
  const denied = new Set([
    ...stringArray(config.disallowedTools), ...stringArray(boundary.hardDeniedActions),
  ].map(leafToolName));
  const configured = stringArray(config.allowedTools);
  const allowed = new Set([...configured, ...stringArray(config.requiresApprovalTools)].map(leafToolName));
  const requested = new Set(requestedTools.map(leafToolName));
  return resolveWorkshopSdkAllowedTools(workshop, registeredTools).filter((name) => {
    const leaf = leafToolName(name);
    if (denied.has(leaf)) return false;
    if (leaf === 'skill') return hasConfiguredSkills(config);
    return requested.has(leaf) && (!configured.length || allowed.has(leaf));
  });
}

/** The executor's broad base profile is a ceiling, not a request to widen an explicit Work allowlist. */
export function restrictWorkshopPiRequestedTools(
  workshop: Pick<Workshop, "modelConfig">,
  profileTools: readonly string[],
) {
  const config = asRecord(workshop.modelConfig);
  const configured = stringArray(config.allowedTools);
  if (!configured.length) return [...profileTools];
  const allowed = new Set([
    ...configured, ...stringArray(config.requiresApprovalTools),
  ].map(leafToolName));
  return profileTools.filter((tool) => allowed.has(leafToolName(tool)));
}
