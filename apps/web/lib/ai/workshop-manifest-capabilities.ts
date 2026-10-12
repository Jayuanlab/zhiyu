import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";
import { listRegisteredAgentTools } from "@/lib/agent-tools/registry";
import { loadSkills } from "@/lib/ai/skills/loader";

function listProjectSkills() {
  const skillsByName = new Map(
    loadSkills().map((skill) => [
      skill.name,
      {
        name: skill.name,
        description: skill.description,
      },
    ]),
  );

  for (const baseDir of [
    join(process.cwd(), "skills"),
    join(process.cwd(), "..", "..", "skills"),
  ]) {
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!existsSync(join(baseDir, entry.name, "SKILL.md"))) continue;
      if (!skillsByName.has(entry.name)) {
        skillsByName.set(entry.name, {
          name: entry.name,
          description: "Project skill available to workshop manifests.",
        });
      }
    }
  }

  return Array.from(skillsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function summarizeWorkshopTools() {
  const descriptors = new Map(
    listRegisteredAgentTools().map((descriptor) => [
      descriptor.name,
      descriptor,
    ]),
  );
  const matrix = buildAgentToolMatrix({
    runtime: "workshop",
    workshop: {
      autonomyLevel: "draft",
      boundaryPolicy: {
        mode: "draft",
        externalMessages: "draft",
        deniedPrecedence: true,
      },
    },
  });

  return matrix.tools
    .map((item) => {
      const descriptor = descriptors.get(item.name);
      return {
        name: item.name,
        displayName: item.displayName,
        description: descriptor?.description ?? item.description,
        capabilities: item.capabilities,
        risk: item.risk,
        availability: item.availability,
        decisionReason: item.decisionReason,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildWorkshopManifestCapabilities(input: { applyAvailable?: boolean } = {}) {
  const applyAvailable = input.applyAvailable ?? true;
  return {
    ok: true,
    manifestApiVersion: "openzhiyu.ai/v1alpha1",
    manifestKind: "Workshop",
    tools: summarizeWorkshopTools(),
    skills: listProjectSkills(),
    application: {
      availableInCurrentTurn: applyAvailable,
      workshopUrl: "/workshop",
      reviewCreatesWorkshop: false,
    },
    workflow: [
      "Clarify the user's controlled object, objective, observation inputs, state, actions, boundaries, feedback, and human review points.",
      "Draft a complete YAML manifest.",
      "Call reviewWorkshopManifestYaml with the YAML.",
      "Fix every error and rerun review until ok=true.",
      "Show the final YAML and review summary to the user.",
      applyAvailable
        ? "After the owner directly instructs application, call applyWorkshopManifestYaml with an empty object to apply the exact server-bound reviewed draft. No separate UI confirmation is required. Report creation only from a verified real Workshop receipt."
        : "This turn can prepare and review YAML only. The owner can say apply this configuration in this chat or click Apply to Workshop below the latest passed review. Either action applies the reviewed draft directly without an extra confirmation. Do not claim creation until an apply receipt returns a real Workshop ID.",
    ],
  };
}
