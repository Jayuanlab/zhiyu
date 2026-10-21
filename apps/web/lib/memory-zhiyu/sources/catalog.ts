import { createSourceRegistry } from "../../../../../packages/memory/src/sources";
export const PLATFORM_SOURCE_DEFINITIONS = [
  [
    "workshops",
    "owner",
    "id",
    "id name mission status autonomyLevel boundaryPolicy createdAt updatedAt",
  ],
  [
    "loops",
    "owner",
    "id",
    "id workshopId name goal status triggerConfig actionPolicy approvalPolicy createdAt updatedAt",
  ],
  [
    "loopStates",
    "loop",
    "loopId",
    "loopId currentPhase memorySummary openQuestions lastObservation nextAction blockedReason updatedAt",
  ],
  [
    "loopRuns",
    "loop",
    "id",
    "id loopId status triggerReason startedAt completedAt outputSummary verificationResult error createdAt",
  ],
  [
    "loopApprovalRequests",
    "owner",
    "id",
    "id loopId loopRunId status actionName capability reason resolutionNote resolvedAt createdAt",
  ],
  [
    "workshopRuns",
    "work",
    "id",
    "id workshopId status triggerReason outputSummary error startedAt completedAt createdAt",
  ],
  [
    "workshopEvents",
    "work",
    "id",
    "id workshopId runId loopId loopRunId seq type title body visibility createdAt",
  ],
  [
    "workshopSources",
    "work",
    "id",
    "id workshopId type name content enabled lastCheckedAt createdAt",
  ],
  [
    "workshopDirectives",
    "work",
    "id",
    "id workshopId runId content priority scope status createdAt",
  ],
  [
    "workshopReviewItems",
    "work",
    "id",
    "id workshopId sourceEventId kind status title summary riskLevel resolvedAt createdAt",
  ],
  [
    "workshopOutbox",
    "work",
    "id",
    "id workshopId runId channel recipientName message status riskLevel sourceEventIds boundaryResult sentAt createdAt",
  ],
  [
    "workshopWorkVersions",
    "work",
    "id",
    "id workshopId version source changeEventId createdBy createdAt",
  ],
  [
    "workshopRuntimeSnapshots",
    "work",
    "id",
    "id workshopId runId engine adapter model modelTier runtimeHash policyHash allowedToolCount createdAt",
  ],
  [
    "workshopHeartbeats",
    "work",
    "workshopId",
    "workshopId enabled mode nextWakeupAt lastWakeupAt lastHeartbeatAt schedulerStatus schedulerError consecutiveFailures createdAt",
  ],
  [
    "brainMemories",
    "owner",
    "id",
    "id scopeType scopeId ownerType ownerId memoryType subject content status confidence evidenceRefs expiresAt supersedes canonicalKind createdAt updatedAt",
  ],
  [
    "brainContextLogs",
    "owner",
    "id",
    "id requesterType requesterId taskIntent selectedMemoryIds denied omitted createdAt",
  ],
  [
    "brainStateSnapshots",
    "owner",
    "id",
    "id scopeType scopeId snapshotType content sourceMemoryIds createdAt",
  ],
  [
    "brainObservations",
    "owner",
    "id",
    "id sourceType sourceId sourceEventId observedAt content contentHash trustLevel createdAt",
  ],
  [
    "interactionEvents",
    "owner",
    "id",
    "id platform source conversationName senderDisplayName direction contentType content messageTime collectedAt processedStatus createdAt",
  ],
  [
    "interactionThreads",
    "owner",
    "id",
    "id platform conversationName summary lastMessageAt lastCollectedAt unreadCount pendingReplyCount createdAt",
  ],
  [
    "interactionTasks",
    "owner",
    "id",
    "id eventId threadId title description status dueAt assigneeName requesterName sourceEventIds confidence createdAt",
  ],
  [
    "interactionNotes",
    "owner",
    "id",
    "id eventId threadId noteType title body confidence model sourceEventIds createdAt",
  ],
  [
    "interactionMemories",
    "owner",
    "id",
    "id memoryType subject content status confidence sourceEventIds lastVerifiedAt expiresAt createdAt",
  ],
  [
    "memoryGraphRelations",
    "owner",
    "id",
    "id subjectEntityId objectEntityId relationType claim confidence evidenceStrength status createdAt",
  ],
  [
    "memoryGraphEntities",
    "owner",
    "id",
    "id name entityType description createdAt",
  ],
  [
    "memoryGraphEvidence",
    "owner",
    "id",
    "id relationId sourceType sourceId eventId quote createdAt",
  ],
  [
    "workRunEvidenceBundles",
    "owner",
    "id",
    "id workshopId workshopRunId loopId loopRunId captureStatus completeness warnings createdAt",
  ],
  [
    "workRunDiagnostics",
    "bundle",
    "id",
    "id evidenceBundleId failureClasses symptoms rootCauseCandidates confidence status createdAt",
  ],
  ["chat", "owner", "id", "id title visibility createdAt"],
  ["message", "chat", "id", "id chatId role parts createdAt"],
  [
    "quantTradePlans",
    "work",
    "id",
    "id workshopId runId code name planDate action side quantity targetPrice status executionStatus blockerReason rationale sourceEventId orderId createdAt",
  ],
  [
    "workshopMemories",
    "work",
    "id",
    "id workshopId kind content confidence tags sourceEventIds expiresAt createdAt updatedAt",
  ],
  [
    "brainAccessGrants",
    "owner",
    "id",
    "id subjectType subjectId scopeType scopeId permissions memoryTypes reason expiresAt createdAt updatedAt",
  ],
] as const;
export type PlatformSourceName =
  (typeof PLATFORM_SOURCE_DEFINITIONS)[number][0];
export type MemorySourceKind =
  | PlatformSourceName
  | "rag-document"
  | "rag-document-metadata";
export type MemorySourceSemantics =
  | "stored_observation"
  | "read_time_observation"
  | "stored_control"
  | "derived_content";
const historical = new Set<PlatformSourceName>([
  "workshopEvents",
  "interactionEvents",
  "message",
  "brainObservations",
]);
const controls = new Set<PlatformSourceName>([
  "workshops",
  "loops",
  "workshopDirectives",
  "workshopSources",
]);
export function memorySourceSemantics(
  source: MemorySourceKind,
): MemorySourceSemantics {
  if (source === "rag-document") return "derived_content";
  if (source === "rag-document-metadata") return "read_time_observation";
  if (historical.has(source)) return "stored_observation";
  if (controls.has(source)) return "stored_control";
  if (
    [
      "workshopMemories",
      "interactionNotes",
      "interactionMemories",
      "memoryGraphRelations",
      "memoryGraphEntities",
    ].includes(source)
  )
    return "derived_content";
  return "read_time_observation";
}
const installedSources = createSourceRegistry([
  ...PLATFORM_SOURCE_DEFINITIONS.map(([id]) => ({
    id,
    adapterVersion: "zhiyu-source-catalog.g2",
    kind: id,
    trustLevel: "host_registered",
  })),
  ...["rag-document", "rag-document-metadata"].map((id) => ({
    id,
    adapterVersion: "zhiyu-source-catalog.g2",
    kind: id,
    trustLevel: "host_registered",
  })),
]);
export const isRegisteredZhiyuSource = (id: string) => installedSources.has(id);
export function memorySourceCatalog() {
  return {
    schemaVersion: "memory-sources.v1" as const,
    coverage: "bounded" as const,
    complete: false as const,
    supportedDispatchRuntimes: [
      "pi-agent-harness",
      "pi-agent-core",
      "claude-sdk-controlled-http",
    ],
    managedSources: [
      {
        kind: "workspace_file_snapshot",
        origin: "owned_chat_relative_path_hash_stat_import_receipt",
        semantics: "immutable_imported_snapshot",
        originalFileCurrent: false,
        access: "owner_or_explicit_current_work_binding",
        dispatch: "physical_bytes_manifest_authority_each_request",
      },
      {
        kind: "approved_plan",
        origin: "owner_input_observation_and_actual_source_receipts",
        semantics: "versioned_control_proposal",
        legacyHistoricalSources: "unknown_until_explicit_owner_rebase",
        dispatch: "source_versions_latest_approval_and_expiry_each_request",
      },
    ],
    sources: [
      ...PLATFORM_SOURCE_DEFINITIONS.map(([kind, ownership]) => ({
        kind,
        semantics: memorySourceSemantics(kind),
        owner: "exact_owner_row" as const,
        work:
          ownership === "work" ||
          ownership === "loop" ||
          kind === "workshops" ||
          kind === "loops"
            ? ("current_work_or_saved_link_unscoped_history" as const)
            : ("unavailable" as const),
        version: "stored_row_and_authority_sha256" as const,
        receipt: "context_log" as const,
        dispatch: "each_logical_pi_request" as const,
      })),
      {
        kind: "rag-document" as const,
        semantics: memorySourceSemantics("rag-document"),
        owner: "exact_owner_row" as const,
        work: "unavailable" as const,
        version: "document_and_chunks_sha256" as const,
        receipt: "context_log" as const,
        dispatch: "each_logical_pi_request" as const,
      },
      {
        kind: "rag-document-metadata" as const,
        semantics: memorySourceSemantics("rag-document-metadata"),
        owner: "exact_owner_row" as const,
        work: "unavailable" as const,
        version: "document_metadata_sha256" as const,
        receipt: "context_log" as const,
        dispatch: "each_logical_pi_request" as const,
      },
    ],
    gaps: [
      {
        kind: "local_workspace",
        code: "memory_source_unregistered",
        recovery:
          "Import the selected file as a managed private artifact and read its artifact ID.",
      },
      {
        kind: "legacy_cloud_file",
        code: "memory_source_unregistered",
        recovery:
          "Import through the managed artifact upload; arbitrary URLs do not grant access.",
      },
      {
        kind: "paper_ledger_remote",
        code: "external_observation_at_t0",
        recovery:
          "Use the domain controller's current read; a remote observation is not a continuously current PG source.",
      },
      {
        kind: "external_tool",
        code: "external_observation_at_t0",
        recovery:
          "Preserve provider time and degradation. It is not a stored-source permission proof.",
      },
      {
        kind: "unisolated_shell",
        code: "memory_source_unregistered",
        recovery:
          "Use an approved domain action or manually import the required private artifact; shell cwd is not filesystem isolation.",
      },
      {
        kind: "cached_insight_or_rendered_work_history",
        code: "memory_source_unregistered",
        recovery:
          "Review the original owner domain record or import selected content as a controlled source. Caller-cached prose is not a stored version.",
      },
    ],
  };
}
