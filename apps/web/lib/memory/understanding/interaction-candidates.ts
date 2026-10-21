import { z } from "zod";
import { jsonrepair } from "jsonrepair";

const privacyClassSchema = z
  .enum(["normal", "private", "sensitive", "regulated"])
  .default("normal");
const riskLevelSchema = z.enum(["low", "medium", "high"]).default("low");
const atomTypeSchema = z
  .enum([
    "todo",
    "reply_needed",
    "commitment",
    "fact",
    "preference",
    "relationship",
    "risk",
    "decision",
  ])
  .default("fact");
const scenarioHintsSchema = z
  .array(
    z.object({
      type: z.enum([
        "person",
        "group",
        "project",
        "topic",
        "transaction",
        "family",
        "work",
      ]),
      key: z.string().min(1),
      title: z.string().min(1),
    }),
  )
  .default([]);

export const interactionCandidatePlanSchema = z.object({
  notes: z
    .array(
      z.object({
        noteType: z
          .enum([
            "summary",
            "classification",
            "reply_need",
            "risk",
            "relationship",
            "project_context",
          ])
          .default("summary"),
        title: z.string().min(1),
        body: z.string().min(1),
        confidence: z.coerce.number().min(0).max(100).default(60),
        sourceEventIds: z.array(z.string()).min(1),
        privacyClass: privacyClassSchema,
        riskLevel: riskLevelSchema,
        scenarioHints: scenarioHintsSchema,
      }),
    )
    .default([]),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
        assigneeName: z.string().nullable().optional(),
        requesterName: z.string().nullable().optional(),
        confidence: z.coerce.number().min(0).max(100).default(60),
        sourceEventIds: z.array(z.string()).min(1),
        atomType: atomTypeSchema.default("todo"),
        privacyClass: privacyClassSchema,
        riskLevel: riskLevelSchema,
        scenarioHints: scenarioHintsSchema,
      }),
    )
    .default([]),
  memories: z
    .array(
      z.object({
        memoryType: z
          .enum([
            "person",
            "preference",
            "project",
            "relationship",
            "commitment",
            "routine",
            "boundary",
            "mistake",
          ])
          .default("project"),
        subject: z.string().min(1),
        content: z.string().min(1),
        confidence: z.coerce.number().min(0).max(100).default(60),
        tags: z.array(z.string()).default([]),
        sourceEventIds: z.array(z.string()).min(1),
        atomType: atomTypeSchema,
        privacyClass: privacyClassSchema,
        riskLevel: riskLevelSchema,
        scenarioHints: scenarioHintsSchema,
        expiresAt: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export const interactionAnalysisSchema = z.object({
  summary: z.string().min(1),
  topics: z.array(z.string()).default([]),
  entities: z
    .array(z.object({ name: z.string(), type: z.string(), role: z.string() }))
    .default([]),
  facts: z
    .array(
      z.object({
        claim: z.string(),
        sourceEventIds: z.array(z.string()).min(1),
        evidenceStrength: z.enum(["high", "medium", "low"]),
      }),
    )
    .default([]),
  decisions: z.array(z.string()).default([]),
  commitments: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
});

export type InteractionAnalysis = z.infer<typeof interactionAnalysisSchema>;
export type InteractionCandidatePlan = z.infer<typeof interactionCandidatePlanSchema>;

export function extractInteractionJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(jsonrepair(fenced));
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(jsonrepair(trimmed.slice(start, end + 1)));
    }
    try {
      return JSON.parse(jsonrepair(trimmed));
    } catch {
      // Fall through to the clearer domain error below.
    }
    throw new Error("Interaction processor did not return JSON.");
  }
}

/** Restricts proposed evidence to the exact authorized input batch; this does not grant access. */
export function createInteractionSourceFilter(authorizedSourceIds: readonly string[]) {
  const allowedIds = new Set(authorizedSourceIds);
  return (sourceIds: string[]) => [...new Set(sourceIds.filter(id => allowedIds.has(id)))];
}
