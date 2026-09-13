import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "next-auth";
import { z } from "zod";
import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";
import { listRegisteredAgentTools } from "@/lib/agent-tools/registry";
import { loadSkills } from "@/lib/ai/skills/loader";
import { commandPayloadHash } from "@/lib/work-runtime/command-payload";
import {
  applyWorkshopManifest,
  reviewWorkshopManifest,
} from "@/lib/workshops/manifest";

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

function toolText(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function createWorkshopManifestTools(session: Session) {
  return [
    tool(
      "listWorkshopManifestCapabilities",
      [
        "List the actual tools and skills that may be referenced by a Workshop YAML manifest.",
        "Use this before drafting a new Workshop manifest, especially when the user asks what can be built or what tools exist.",
        "The returned tool names are the identifiers to use in spec.modelConfig.allowedTools, spec.sources connector names, loop actionPolicy, and verification.requiredSources.",
      ].join("\n"),
      {},
      async () =>
        toolText({
          ok: true,
          manifestApiVersion: "openzhiyu.ai/v1alpha1",
          manifestKind: "Workshop",
          tools: summarizeWorkshopTools(),
          skills: listProjectSkills(),
          workflow: [
            "Clarify the user's controlled object, objective, observation inputs, state, actions, boundaries, feedback, and human review points.",
            "Draft a complete YAML manifest.",
            "Call reviewWorkshopManifestYaml with the YAML.",
            "Fix every error and rerun review until ok=true.",
            "Show the final YAML and review summary to the user.",
            "Only call applyWorkshopManifestYaml after the user explicitly confirms creation.",
          ],
        }),
    ),
    tool(
      "reviewWorkshopManifestYaml",
      [
        "Dry-run review a Workshop YAML manifest without creating anything.",
        "Use this after drafting or editing a manifest. Treat ok=false as blocking.",
        "The review checks schema fields, usable tools, known skills, denied precedence, role-specific constraints, and duplicate manifest names.",
      ].join("\n"),
      {
        manifestYaml: z.string().min(20),
      },
      async ({ manifestYaml }) => {
        const result = await reviewWorkshopManifest({
          userId: session.user.id,
          manifestYaml,
        });
        return toolText({
          ok: true,
          review: result.review,
          manifest: result.manifest,
        });
      },
    ),
    tool(
      "applyWorkshopManifestYaml",
      [
        "Create a Workshop from a reviewed YAML manifest.",
        "Only use after reviewWorkshopManifestYaml returned ok=true and the user explicitly confirmed creation in the chat.",
        "This tool performs a fresh review first; if the manifest is invalid, it refuses to create the workshop.",
        "Do not use for experiments, drafts, or when the user only asks for YAML text.",
      ].join("\n"),
      {
        manifestYaml: z.string().min(20),
        userConfirmation: z
          .string()
          .min(6)
          .describe(
            "Short quote or summary of the user's explicit confirmation to create/apply this workshop.",
          ),
        commandId: z.string().min(1).max(256).optional().describe("Stable request ID; reuse the same ID when retrying the same confirmed manifest."),
      },
      async ({ manifestYaml, userConfirmation, commandId }) => {
        try {
          const result = await applyWorkshopManifest({
            userId: session.user.id,
            manifestYaml,
            commandId: commandId ?? `manifest:${commandPayloadHash({manifestYaml, userConfirmation})}`,
            source: "chat_agent",
            reason: userConfirmation,
          });
          return toolText({
            ok: true,
            message: "Workshop created from reviewed manifest.",
            userConfirmation,
            workshop: {
              id: result.workshop.id,
              name: result.workshop.name,
              mission: result.workshop.mission,
              status: result.workshop.status,
              autonomyLevel: result.workshop.autonomyLevel,
            },
            created: result.created,
            review: result.review,
          });
        } catch (error) {
          return {
            ...toolText({
              ok: false,
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to create workshop from manifest.",
            }),
            isError: true,
          };
        }
      },
    ),
  ];
}
