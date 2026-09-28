import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "next-auth";
import { z } from "zod";
import { buildWorkshopManifestCapabilities } from "@/lib/ai/workshop-manifest-capabilities";
import { commandPayloadHash } from "@/lib/work-runtime/command-payload";
import {
  applyWorkshopManifest,
  reviewWorkshopManifest,
} from "@/lib/workshops/manifest";

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
      async () => toolText(buildWorkshopManifestCapabilities()),
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
