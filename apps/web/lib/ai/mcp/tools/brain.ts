import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "next-auth";
import { z } from "zod";
import {
  createBrainMemoryCandidate,
  createBrainStateSnapshot,
  grantBrainAccess,
  listBrainGrants,
  reviewBrainMemory,
  revokeBrainAccess,
  writeBrainMemory,
} from "@/lib/brain/service";
import {
  listBrainCandidatesForUser,
  listBrainGrantsForUser,
  listBrainMemoriesForUser,
  listBrainSnapshotsForUser,
} from "@/lib/ai/brain-read-tools";

const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("workspace"), workspaceId: z.string().min(1) }),
  z.object({ type: z.literal("workshop"), workshopId: z.string().min(1) }),
  z.object({ type: z.literal("work"), workId: z.string().min(1) }),
]);

const memoryTypeSchema = z.enum([
  "fact",
  "preference",
  "plan",
  "boundary",
  "relationship",
  "task",
  "insight",
  "system",
]);

const memoryStatusSchema = z.enum([
  "candidate",
  "active",
  "verified",
  "weakened",
  "superseded",
  "deleted",
]);

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function createBrainTools(session: Session) {
  const requester = {
    type: "chat" as const,
    userId: session.user.id,
    id: "brain-mcp",
  };

  return [
    tool(
      "brainListMemories",
      "List reviewed Brain memories for the owner. Use this for Brain-native memory inspection.",
      {
        limit: z.coerce.number().int().min(1).max(100).default(20),
        statuses: z.array(memoryStatusSchema).optional(),
        memoryTypes: z.array(memoryTypeSchema).optional(),
        ownerType: z.enum(["chat", "work", "system"]).optional(),
        ownerId: z.string().optional(),
      },
      async (args) => {
        const result = await listBrainMemoriesForUser({
          userId: session.user.id,
          limit: args.limit,
          statuses: args.statuses,
          memoryTypes: args.memoryTypes,
          ownerType: args.ownerType,
          ownerId: args.ownerId,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          data: result.data,
          isError: result.isError,
        };
      },
    ),
    tool(
      "brainWriteMemory",
      [
        "Write a reviewed Brain memory. Active or verified memories require evidenceRefs.",
        "Use brainWriteCandidate when the claim is weak, uncertain, or needs owner review.",
      ].join("\n"),
      {
        scope: scopeSchema.default({ type: "global" }),
        ownerType: z.enum(["chat", "work", "system"]).default("chat"),
        ownerId: z.string().optional(),
        memoryType: memoryTypeSchema.default("fact"),
        subject: z.string().min(1),
        content: z.string().min(1),
        status: memoryStatusSchema.default("active"),
        confidence: z.coerce.number().min(0).max(100).default(70),
        evidenceRefs: z.array(z.string()).default([]),
        tags: z.array(z.string()).default([]),
      },
      async (args) => {
        const memory = await writeBrainMemory({
          requester,
          scope: args.scope,
          ownerType: args.ownerType,
          ownerId: args.ownerId ?? session.user.id,
          memoryType: args.memoryType,
          subject: args.subject,
          content: args.content,
          status: args.status,
          confidence: args.confidence,
          evidenceRefs: args.evidenceRefs,
          tags: args.tags,
        });
        return {
          content: [{ type: "text" as const, text: jsonText({ memory }) }],
          data: { memory },
        };
      },
    ),
    tool(
      "brainWriteCandidate",
      "Write a Brain candidate memory for later owner or steward review.",
      {
        scope: scopeSchema.default({ type: "global" }),
        ownerType: z.enum(["chat", "work", "system"]).default("chat"),
        ownerId: z.string().optional(),
        memoryType: memoryTypeSchema.default("fact"),
        subject: z.string().min(1),
        content: z.string().min(1),
        confidence: z.coerce.number().min(0).max(100).default(50),
        evidenceRefs: z.array(z.string()).default([]),
        tags: z.array(z.string()).default([]),
      },
      async (args) => {
        const candidate = await createBrainMemoryCandidate({
          requester,
          scope: args.scope,
          ownerType: args.ownerType,
          ownerId: args.ownerId ?? session.user.id,
          memoryType: args.memoryType,
          subject: args.subject,
          content: args.content,
          confidence: args.confidence,
          evidenceRefs: args.evidenceRefs,
          tags: args.tags,
        });
        return {
          content: [{ type: "text" as const, text: jsonText({ candidate }) }],
          data: { candidate },
        };
      },
    ),
    tool(
      "brainListCandidates",
      "List Brain candidate memories awaiting review.",
      {
        limit: z.coerce.number().int().min(1).max(100).default(20),
        ownerType: z.enum(["chat", "work", "system"]).optional(),
        ownerId: z.string().optional(),
      },
      async (args) => {
        const result = await listBrainCandidatesForUser({
          userId: session.user.id,
          limit: args.limit,
          ownerType: args.ownerType,
          ownerId: args.ownerId,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          data: result.data,
          isError: result.isError,
        };
      },
    ),
    tool(
      "brainReviewCandidate",
      "Confirm or dismiss a Brain candidate memory after checking evidence.",
      {
        memoryId: z.string().min(1),
        decision: z.enum(["confirmed", "dismissed"]),
        reason: z.string().optional(),
      },
      async (args) => {
        const memory = await reviewBrainMemory({
          requester,
          memoryId: args.memoryId,
          decision: args.decision,
          reason: args.reason,
        });
        return {
          content: [{ type: "text" as const, text: jsonText({ memory }) }],
          data: { memory },
        };
      },
    ),
    tool(
      "brainListSnapshots",
      "List Brain state snapshots such as work_state, trading_plan_state, or owner_context_state.",
      {
        limit: z.coerce.number().int().min(1).max(100).default(20),
        snapshotTypes: z.array(z.string()).optional(),
      },
      async (args) => {
        const result = await listBrainSnapshotsForUser({
          userId: session.user.id,
          limit: args.limit,
          snapshotTypes: args.snapshotTypes,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          data: result.data,
          isError: result.isError,
        };
      },
    ),
    tool(
      "brainWriteSnapshot",
      "Write a Brain state snapshot. Use snapshots for current state estimates, daily plans, and execution status.",
      {
        scope: scopeSchema.default({ type: "global" }),
        snapshotType: z.string().min(1),
        content: z.record(z.string(), z.unknown()).default({}),
        sourceMemoryIds: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.unknown()).default({}),
      },
      async (args) => {
        const snapshot = await createBrainStateSnapshot({
          userId: session.user.id,
          scope: args.scope,
          snapshotType: args.snapshotType,
          content: args.content,
          sourceMemoryIds: args.sourceMemoryIds,
          metadata: args.metadata,
        });
        return {
          content: [{ type: "text" as const, text: jsonText({ snapshot }) }],
          data: { snapshot },
        };
      },
    ),
    tool(
      "brainManageGrants",
      "List, create, or revoke Brain access grants controlling cross-work memory visibility.",
      {
        action: z.enum(["list", "create", "revoke"]),
        grantId: z.string().optional(),
        subjectType: z.enum(["chat", "work", "loop", "tool", "system"]).optional(),
        subjectId: z.string().optional(),
        scope: scopeSchema.optional(),
        permissions: z
          .array(z.enum(["read", "reference", "write", "review"]))
          .optional(),
        memoryTypes: z.array(memoryTypeSchema).optional(),
        reason: z.string().optional(),
      },
      async (args) => {
        if (args.action === "revoke") {
          if (!args.grantId) throw new Error("grantId is required");
          const result = await revokeBrainAccess({
            userId: session.user.id,
            grantId: args.grantId,
          });
          return {
            content: [{ type: "text" as const, text: jsonText(result) }],
            data: result,
          };
        }
        if (args.action === "create") {
          if (!args.scope) throw new Error("scope is required");
          const grant = await grantBrainAccess({
            userId: session.user.id,
            subjectType: args.subjectType ?? "work",
            subjectId: args.subjectId,
            scope: args.scope,
            permissions: args.permissions ?? ["reference"],
            memoryTypes: args.memoryTypes,
            reason: args.reason,
          });
          return {
            content: [{ type: "text" as const, text: jsonText({ grant }) }],
            data: { grant },
          };
        }
        const result = await listBrainGrantsForUser({
          userId: session.user.id,
          subjectType: args.subjectType,
          subjectId: args.subjectId,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          data: result.data,
          isError: result.isError,
        };
      },
    ),
  ];
}
