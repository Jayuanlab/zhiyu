import YAML from "yaml";
import {sql} from "drizzle-orm";
import {runPreparedDatabaseWorkCommand} from "@/lib/work-runtime/database-command";
import {runWorkLifecycleCommand} from "@/lib/work-runtime/lifecycle-command";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";
import {applyUpdateWorkLoop} from "@/lib/work-runtime/commands";
import type {WorkCommandMeta} from "@/lib/work-runtime/types";
import type {WorkshopWriteContext} from "./service";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";
import { listRegisteredAgentTools } from "@/lib/agent-tools/registry";
import { loadSkills } from "@/lib/ai/skills/loader";
import {
  createLoop,
  getLoopState,
  upsertLoopState,
  listLoopsForWorkshop,
  updateLoop,
  type LoopStatus,
} from "@/lib/loops";
import { safeParseLoopSpec } from "@/lib/loops/spec";
import { parseBrainRecallProfilesFromModelConfig } from "@/lib/brain/recall-profiles";
import { serializeWorkshopBoundaryPolicy } from "./boundary-policy";
import {
  addWorkshopSource,
  appendWorkshopEvent,
  createWorkshop,
  getWorkshop,
  listWorkshopSources,
  listWorkshopSourceNames,
  listWorkshops,
  updateWorkshop,
} from "./service";
import type {
  WorkshopAutonomyLevel,
  WorkshopSourceType,
  WorkshopJson,
} from "./types";

type JsonRecord = Record<string, unknown>;

type ManifestIssueSeverity = "error" | "warning";

export type WorkshopManifestReviewIssue = {
  severity: ManifestIssueSeverity;
  path: string;
  message: string;
};

export type WorkshopManifestReview = {
  ok: boolean;
  manifestName: string | null;
  title: string | null;
  summary: {
    loops: number;
    sources: number;
    requestedTools: number;
    requestedSkills: number;
    deniedTools: number;
  };
  issues: WorkshopManifestReviewIssue[];
  requestedTools: string[];
  deniedTools: string[];
  requestedSkills: string[];
  creationReport: {
    title: string;
    body: string;
  } | null;
};

export type ApplyWorkshopManifestResult = {
  workshop: Awaited<ReturnType<typeof createWorkshop>>;
  review: WorkshopManifestReview;
  created: {
    sources: number;
    loops: number;
  };
};

export type ApplyWorkshopManifestToExistingResult = {
  workshop: Awaited<ReturnType<typeof createWorkshop>>;
  review: WorkshopManifestReview;
  updated: {
    workshop: boolean;
    loops: number;
    sources: number;
  };
  created: {
    loops: number;
    sources: number;
  };
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): JsonRecord {
  const next = isRecord(value) ? value[key] : undefined;
  return isRecord(next) ? next : {};
}

function arrayAt(value: unknown, key: string): unknown[] {
  const next = isRecord(value) ? value[key] : undefined;
  return Array.isArray(next) ? next : [];
}

function stringAt(value: unknown, key: string): string {
  const next = isRecord(value) ? value[key] : undefined;
  return typeof next === "string" ? next.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean),
        ),
      )
    : [];
}

function addIssue(
  issues: WorkshopManifestReviewIssue[],
  severity: ManifestIssueSeverity,
  path: string,
  message: string,
) {
  issues.push({ severity, path, message });
}

export function parseWorkshopManifestYaml(yamlText: string): JsonRecord {
  const parsed = YAML.parse(yamlText);
  if (!isRecord(parsed)) {
    throw new Error("Manifest must be a YAML object.");
  }
  return parsed;
}

function collectToolsFromActionPolicy(policy: unknown) {
  const record = normalizeLoopActionPolicy(policy);
  return {
    allowed: stringList(record.allowed),
    requiresApproval: stringList(record.requiresApproval),
    denied: stringList(record.denied),
  };
}

function normalizeLoopActionPolicy(policy: unknown): JsonRecord {
  const record = isRecord(policy) ? policy : {};
  return {
    allowed: [
      ...stringList(record.allowed),
      ...stringList(record.allowedTools),
    ],
    requiresApproval: [
      ...stringList(record.requiresApproval),
      ...stringList(record.approvalRequiredTools),
      ...stringList(record.requiresApprovalTools),
    ],
    denied: [
      ...stringList(record.denied),
      ...stringList(record.deniedTools),
    ],
    ...(typeof record.externalWriteMode === "string"
      ? { externalWriteMode: record.externalWriteMode }
      : {}),
    ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
    ...(typeof record.notes === "string" ? { notes: record.notes } : {}),
    ...(record.deniedPrecedence === true ? { deniedPrecedence: true } : {}),
  };
}

function collectManifestTools(manifest: JsonRecord) {
  const spec = recordAt(manifest, "spec");
  const modelConfig = recordAt(spec, "modelConfig");
  const boundaryPolicy = recordAt(spec, "boundaryPolicy");
  const loops = arrayAt(spec, "loops").filter(isRecord);
  const sources = arrayAt(spec, "sources").filter(isRecord);
  const sourceTools = sources
    .filter((source) => stringAt(source, "type") === "connector")
    .map((source) => stringAt(source, "name"))
    .filter(Boolean);

  const allowed = [
    ...stringList(modelConfig.allowedTools),
    ...stringList(modelConfig.observationTools),
    ...sourceTools,
  ];
  const denied = [
    ...stringList(modelConfig.disallowedTools),
    ...stringList(boundaryPolicy.hardDeniedActions),
  ];
  const requiresApproval: string[] = [];

  for (const [index, loop] of loops.entries()) {
    const actionPolicy = collectToolsFromActionPolicy(loop.actionPolicy);
    allowed.push(...actionPolicy.allowed);
    denied.push(...actionPolicy.denied);
    requiresApproval.push(...actionPolicy.requiresApproval);

    const contextSources = arrayAt(recordAt(loop, "context"), "sources").filter(
      isRecord,
    );
    for (const source of contextSources) {
      if (stringAt(source, "type") === "connector") {
        allowed.push(stringAt(source, "name"));
      }
    }

    const verification = recordAt(loop, "verification");
    for (const sourceName of stringList(verification.requiredSources)) {
      if (sourceName.startsWith("aStock") || sourceName.startsWith("quant")) {
        allowed.push(sourceName);
      }
    }

    if (!stringAt(loop, "name")) {
      denied.push(`__invalid_loop_${index}`);
    }
  }

  return {
    allowed: Array.from(new Set(allowed.filter(Boolean))),
    denied: Array.from(new Set(denied.filter(Boolean))),
    requiresApproval: Array.from(new Set(requiresApproval.filter(Boolean))),
  };
}

function collectManifestSkills(manifest: JsonRecord) {
  const spec = recordAt(manifest, "spec");
  const modelConfig = recordAt(spec, "modelConfig");
  const loops = arrayAt(spec, "loops").filter(isRecord);
  return Array.from(
    new Set(
      [
        ...stringList(modelConfig.primarySkills),
        ...loops.map((loop) => stringAt(loop, "skill")),
      ].filter(Boolean),
    ),
  );
}

function supportedToolNames() {
  return new Set(listRegisteredAgentTools().map((tool) => tool.name));
}

function supportedSkillNames() {
  const names = new Set(loadSkills().map((skill) => skill.name));
  for (const baseDir of [
    join(process.cwd(), "skills"),
    join(process.cwd(), "..", "..", "skills"),
  ]) {
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (existsSync(join(baseDir, entry.name, "SKILL.md"))) {
        names.add(entry.name);
      }
    }
  }
  return names;
}

function normalizeAutonomy(value: unknown): WorkshopAutonomyLevel {
  return value === "observe" || value === "auto" ? value : "draft";
}

function sourceType(value: string): WorkshopSourceType | null {
  if (
    value === "url" ||
    value === "rss" ||
    value === "file" ||
    value === "manual" ||
    value === "knowledge" ||
    value === "connector"
  ) {
    return value;
  }
  return null;
}

function asWorkshopJson(value: unknown): WorkshopJson {
  return isRecord(value) ? value : {};
}

function workshopPatchFromManifest(manifest: JsonRecord) {
  const spec = recordAt(manifest, "spec");
  const metadata = recordAt(manifest, "metadata");
  const {mission: _mission, autonomyLevel: _autonomy, modelConfig: _model,
    boundaryPolicy: _boundary, loops: _loops, sources: _sources, ...manifestSpec} = spec;
  const {name: _name, title: _title, ...manifestMetadata} = metadata;
  const boundaryPolicy = recordAt(spec, "boundaryPolicy");
  const modelConfig = {
    ...recordAt(spec, "modelConfig"),
    manifestApiVersion: stringAt(manifest, "apiVersion"),
    manifestKind: stringAt(manifest, "kind"),
    manifestName: stringAt(metadata, "name"),
    manifestTitle: stringAt(metadata, "title"),
    // Preserve the declarative fields that have no dedicated database column.
    // Exclude modelConfig itself to avoid recursively embedding prior exports.
    manifestSpec,
    manifestMetadata,
  };

  return {
    name: stringAt(metadata, "title"),
    mission: stringAt(spec, "mission"),
    autonomyLevel: normalizeAutonomy(spec.autonomyLevel),
    boundaryPolicy: {
      ...serializeWorkshopBoundaryPolicy(boundaryPolicy),
      ...boundaryPolicy,
    },
    modelConfig,
  };
}

function loopNameFromManifest(loop: JsonRecord) {
  return stringAt(loop, "title") || stringAt(loop, "name");
}

function loopPatchFromManifest(loop: JsonRecord) {
  const status: LoopStatus =
    stringAt(loop, "status") === "paused" ? "paused" : "active";
  return {
    name: loopNameFromManifest(loop),
    description: stringAt(loop, "description") || null,
    goal: stringAt(loop, "goal"),
    status,
    triggerConfig: asWorkshopJson(loop.trigger),
    contextConfig: asWorkshopJson(loop.context),
    actionPolicy: normalizeLoopActionPolicy(loop.actionPolicy),
    verificationConfig: asWorkshopJson(loop.verification),
    approvalPolicy: asWorkshopJson(loop.approvalPolicy),
    retryPolicy: normalizeLoopRetryPolicy(loop.retryPolicy),
    escalationPolicy: asWorkshopJson(loop.escalationPolicy),
  };
}

function runtimeLoopSpecFromManifest(loop: JsonRecord) {
  const patch = loopPatchFromManifest(loop);
  return {
    version: 1,
    goal: patch.goal,
    trigger: patch.triggerConfig,
    context: patch.contextConfig,
    actions: patch.actionPolicy,
    verification: patch.verificationConfig,
    approval: patch.approvalPolicy,
    retry: patch.retryPolicy,
    escalation: patch.escalationPolicy,
    metadata: {
      manifestLoopName: stringAt(loop, "name"),
      skill: stringAt(loop, "skill"),
    },
  };
}

function normalizeLoopRetryPolicy(policy: unknown): JsonRecord {
  const record = isRecord(policy) ? policy : {};
  const fallback = stringAt(record, "fallback");
  return {
    maxAttempts:
      typeof record.maxAttempts === "number" ? record.maxAttempts : undefined,
    onFailure:
      stringAt(record, "onFailure") ||
      (["summarize_and_block", "mark_failed", "ask_human"].includes(fallback)
        ? fallback
        : undefined),
  };
}

export async function reviewWorkshopManifest(input: {
  userId: string;
  manifestYaml: string;
  allowExistingWorkshopId?: string;
  existingWorkshops?: Array<{ id?: string; modelConfig?: unknown }>;
}): Promise<{ manifest: JsonRecord; review: WorkshopManifestReview }> {
  const issues: WorkshopManifestReviewIssue[] = [];
  let manifest: JsonRecord;
  try {
    manifest = parseWorkshopManifestYaml(input.manifestYaml);
  } catch (error) {
    const review: WorkshopManifestReview = {
      ok: false,
      manifestName: null,
      title: null,
      summary: {
        loops: 0,
        sources: 0,
        requestedTools: 0,
        requestedSkills: 0,
        deniedTools: 0,
      },
      issues: [
        {
          severity: "error",
          path: "$",
          message:
            error instanceof Error ? error.message : "Manifest YAML parse failed.",
        },
      ],
      requestedTools: [],
      deniedTools: [],
      requestedSkills: [],
      creationReport: null,
    };
    return { manifest: {}, review };
  }

  const spec = recordAt(manifest, "spec");
  const metadata = recordAt(manifest, "metadata");
  const loops = arrayAt(spec, "loops").filter(isRecord);
  const sources = arrayAt(spec, "sources").filter(isRecord);
  const manifestName = stringAt(metadata, "name");
  const title = stringAt(metadata, "title");

  if (manifest.apiVersion !== "openzhiyu.ai/v1alpha1") {
    addIssue(
      issues,
      "error",
      "apiVersion",
      "Only openzhiyu.ai/v1alpha1 Workshop manifests are supported.",
    );
  }
  if (manifest.kind !== "Workshop") {
    addIssue(issues, "error", "kind", "kind must be Workshop.");
  }
  if (!manifestName) {
    addIssue(issues, "error", "metadata.name", "metadata.name is required.");
  }
  if (!title) {
    addIssue(issues, "error", "metadata.title", "metadata.title is required.");
  }
  if (!stringAt(spec, "mission")) {
    addIssue(issues, "error", "spec.mission", "spec.mission is required.");
  }
  if (!stringAt(spec, "role")) {
    addIssue(issues, "error", "spec.role", "spec.role is required.");
  }
  if (!stringAt(recordAt(spec, "control"), "object")) {
    addIssue(
      issues,
      "error",
      "spec.control.object",
      "A controlled object is required.",
    );
  }
  if (!stringAt(recordAt(spec, "control"), "objective")) {
    addIssue(
      issues,
      "error",
      "spec.control.objective",
      "A control objective is required.",
    );
  }

  const boundaryPolicy = recordAt(spec, "boundaryPolicy");
  if (!stringAt(boundaryPolicy, "mode")) {
    addIssue(
      issues,
      "error",
      "spec.boundaryPolicy.mode",
      "boundaryPolicy.mode is required.",
    );
  }
  if (!stringAt(boundaryPolicy, "externalMessages")) {
    addIssue(
      issues,
      "error",
      "spec.boundaryPolicy.externalMessages",
      "boundaryPolicy.externalMessages is required.",
    );
  }
  if (boundaryPolicy.deniedPrecedence !== true) {
    addIssue(
      issues,
      "error",
      "spec.boundaryPolicy.deniedPrecedence",
      "deniedPrecedence must be true.",
    );
  }

  if (loops.length === 0) {
    addIssue(issues, "error", "spec.loops", "At least one loop is required.");
  }

  const loopAliases = new Set<string>();
  for (const [index, loop] of loops.entries()) {
    const base = `spec.loops[${index}]`;
    for (const alias of new Set([stringAt(loop, "name"), stringAt(loop, "title")].filter(Boolean))) {
      if (loopAliases.has(alias)) addIssue(issues, "error", base, `Duplicate or ambiguous Loop name/title: ${alias}`);
      loopAliases.add(alias);
    }
    const titleOrName = stringAt(loop, "title") || stringAt(loop, "name");
    if (!stringAt(loop, "name")) {
      addIssue(issues, "error", `${base}.name`, "Loop name is required.");
    }
    if (!stringAt(loop, "title")) {
      addIssue(issues, "error", `${base}.title`, "Loop title is required.");
    }
    if (!stringAt(loop, "goal")) {
      addIssue(issues, "error", `${base}.goal`, "Loop goal is required.");
    }
    if (!stringAt(loop, "skill")) {
      addIssue(issues, "error", `${base}.skill`, "Loop skill is required.");
    }
    if (stringAt(loop, "status") === "active") {
      const trigger = recordAt(loop, "trigger");
      if (!stringAt(trigger, "type")) {
        addIssue(
          issues,
          "error",
          `${base}.trigger.type`,
          `${titleOrName} active loop must declare a trigger.`,
        );
      }
      if (stringAt(trigger, "type") === "cron" && !stringAt(trigger, "expression")) {
        addIssue(
          issues,
          "error",
          `${base}.trigger.expression`,
          `${titleOrName} cron loop must declare expression.`,
        );
      }
    }
    const actionPolicy = collectToolsFromActionPolicy(loop.actionPolicy);
    if (
      actionPolicy.allowed.length === 0 &&
      actionPolicy.requiresApproval.length === 0
    ) {
      addIssue(
        issues,
        "error",
        `${base}.actionPolicy`,
        `${titleOrName} must declare allowed or approval-required actions.`,
      );
    }
    const verification = recordAt(loop, "verification");
    if (stringList(verification.requiredFields).length === 0) {
      addIssue(
        issues,
        "error",
        `${base}.verification.requiredFields`,
        `${titleOrName} must declare required output fields.`,
      );
    }
    if (stringList(verification.requiredSources).length === 0) {
      addIssue(
        issues,
        "error",
        `${base}.verification.requiredSources`,
        `${titleOrName} must declare required sources.`,
      );
    }
    if (stringList(verification.successCriteria).length === 0) {
      addIssue(
        issues,
        "error",
        `${base}.verification.successCriteria`,
        `${titleOrName} must declare success criteria.`,
      );
    }
    const runtimeSpec = safeParseLoopSpec(runtimeLoopSpecFromManifest(loop));
    if (!runtimeSpec.success) {
      for (const issue of runtimeSpec.error.issues) {
        addIssue(
          issues,
          "error",
          `${base}.${issue.path.join(".")}`,
          `Loop runtime schema rejected this value: ${issue.message}`,
        );
      }
    }
  }

  const sourceNames = new Set<string>();
  for (const [index, source] of sources.entries()) {
    const name = stringAt(source, "name");
    if (name && sourceNames.has(name)) addIssue(issues, "error", `spec.sources[${index}].name`, `Duplicate source name: ${name}`);
    sourceNames.add(name);
    const type = stringAt(source, "type");
    if (!stringAt(source, "name")) {
      addIssue(issues, "error", `spec.sources[${index}].name`, "Source name is required.");
    }
    if (!sourceType(type) && type !== "memory" && type !== "channel") {
      addIssue(
        issues,
        "error",
        `spec.sources[${index}].type`,
        "Source type must be connector, memory, channel, url, rss, file, manual, or knowledge.",
      );
    }
  }

  const tools = collectManifestTools(manifest);
  const requestedTools = Array.from(
    new Set([...tools.allowed, ...tools.requiresApproval].filter(Boolean)),
  );
  const deniedTools = tools.denied;
  const toolNames = supportedToolNames();
  for (const tool of requestedTools) {
    if (!toolNames.has(tool)) {
      addIssue(issues, "error", `tools.${tool}`, `Requested tool does not exist: ${tool}`);
    }
  }

  const modelConfig = recordAt(spec, "modelConfig");
  const recallProfileResult = parseBrainRecallProfilesFromModelConfig(
    modelConfig,
  );
  for (const issue of recallProfileResult.issues) {
    addIssue(
      issues,
      "error",
      `spec.modelConfig.${issue.path}`,
      issue.message,
    );
  }
  const modelDeniedSet = new Set(
    stringList(modelConfig.disallowedTools).map((tool) => tool.toLowerCase()),
  );
  for (const tool of stringList(modelConfig.allowedTools)) {
    if (modelDeniedSet.has(tool.toLowerCase())) {
      addIssue(
        issues,
        "error",
        `spec.modelConfig.allowedTools.${tool}`,
        `Tool is both globally allowed and globally denied; denied must win: ${tool}`,
      );
    }
  }

  for (const [index, loop] of loops.entries()) {
    const actionPolicy = collectToolsFromActionPolicy(loop.actionPolicy);
    const loopDeniedSet = new Set(
      actionPolicy.denied.map((tool) => tool.toLowerCase()),
    );
    for (const tool of [
      ...actionPolicy.allowed,
      ...actionPolicy.requiresApproval,
    ]) {
      if (loopDeniedSet.has(tool.toLowerCase())) {
        addIssue(
          issues,
          "error",
          `spec.loops[${index}].actionPolicy.${tool}`,
          `Tool is both allowed and denied in the same loop; denied must win: ${tool}`,
        );
      }
    }
  }

  const fakeWorkshop = {
    autonomyLevel: normalizeAutonomy(spec.autonomyLevel),
    boundaryPolicy: {
      ...serializeWorkshopBoundaryPolicy(boundaryPolicy),
      ...boundaryPolicy,
    },
  };
  const matrix = buildAgentToolMatrix({
    runtime: "workshop",
    workshop: fakeWorkshop,
  });
  const matrixByName = new Map(matrix.tools.map((tool) => [tool.name, tool]));
  for (const tool of requestedTools) {
    const item = matrixByName.get(tool);
    if (!item) continue;
    if (item.availability === "deny" || item.availability === "disabled") {
      addIssue(
        issues,
        "error",
        `tools.${tool}`,
        `Requested tool is not usable for workshop runtime: ${item.decisionReason}`,
      );
    } else if (
      item.availability === "require_approval" &&
      !tools.requiresApproval.includes(tool)
    ) {
      addIssue(
        issues,
        "warning",
        `tools.${tool}`,
        `Tool requires approval at runtime: ${item.decisionReason}`,
      );
    }
  }

  const requestedSkills = collectManifestSkills(manifest);
  const skillNames = supportedSkillNames();
  for (const skill of requestedSkills) {
    if (!skillNames.has(skill)) {
      addIssue(issues, "error", `skills.${skill}`, `Requested skill does not exist: ${skill}`);
    }
  }

  const role = stringAt(spec, "role");
  if (role === "paper_trader") {
    const lowerRequested = requestedTools.map((tool) => tool.toLowerCase());
    const forbidden = [
      "quantmarketdiscovercandidates",
      "quantpaperproposewatchlistchange",
      "realbrokerorder",
      "externalpayment",
      "wechatsendmessage",
      "outboxsend",
    ];
    for (const forbiddenTool of forbidden) {
      if (lowerRequested.includes(forbiddenTool)) {
        addIssue(
          issues,
          "error",
          `spec.role.${role}`,
          `paper_trader cannot request ${forbiddenTool}.`,
        );
      }
    }
    for (const required of [
      "quantPaperGetAccount",
      "quantPaperGetWatchlist",
      "quantTradePlanList",
    ]) {
      if (!requestedTools.includes(required)) {
        addIssue(
          issues,
          "error",
          `spec.role.${role}`,
          `paper_trader must request ${required}.`,
        );
      }
    }
    for (const loop of loops) {
      const titleText = stringAt(loop, "title");
      const loopTools = collectToolsFromActionPolicy(loop.actionPolicy);
      if (
        (titleText.includes("盘前") ||
          titleText.includes("盘后") ||
          titleText.includes("晚间")) &&
        loopTools.allowed.includes("quantPaperPlaceOrder")
      ) {
        addIssue(
          issues,
          "error",
          `spec.loops.${titleText}.actionPolicy.allowed`,
          `${titleText} cannot allow quantPaperPlaceOrder.`,
        );
      }
      if (titleText.includes("盘中")) {
        const text = [
          stringAt(loop, "goal"),
          stringAt(recordAt(loop, "context"), "instructions"),
          ...stringList(recordAt(loop, "verification").successCriteria),
        ].join("\n");
        for (const required of [
          "tradeThesis",
          "plannedPrice",
          "maxBuyDeviationPct",
          "blocker",
          "tradePlanLedger",
        ]) {
          if (!text.includes(required)) {
            addIssue(
              issues,
              "error",
              `spec.loops.${titleText}`,
              `Intraday paper trader loop must mention ${required}.`,
            );
          }
        }
      }
    }
  }

  const existing =
    input.existingWorkshops ?? (manifestName ? await listWorkshops(input.userId, 1, {manifestName, excludeId: input.allowExistingWorkshopId}) : []);
  if (
    manifestName &&
    existing.some((workshop: { modelConfig?: unknown }) => {
      if (
        input.allowExistingWorkshopId &&
        "id" in workshop &&
        workshop.id === input.allowExistingWorkshopId
      ) {
        return false;
      }
      const modelConfig = isRecord(workshop.modelConfig)
        ? workshop.modelConfig
        : {};
      return modelConfig.manifestName === manifestName;
    })
  ) {
    addIssue(
      issues,
      "error",
      "metadata.name",
      `A workshop created from manifest ${manifestName} already exists.`,
    );
  }

  const creationReport = recordAt(spec, "creationReport");
  const review: WorkshopManifestReview = {
    ok: !issues.some((issue) => issue.severity === "error"),
    manifestName: manifestName || null,
    title: title || null,
    summary: {
      loops: loops.length,
      sources: sources.length,
      requestedTools: requestedTools.length,
      requestedSkills: requestedSkills.length,
      deniedTools: deniedTools.length,
    },
    issues,
    requestedTools,
    deniedTools,
    requestedSkills,
    creationReport: stringAt(creationReport, "title") || stringAt(creationReport, "body")
      ? {
          title: stringAt(creationReport, "title"),
          body: stringAt(creationReport, "body"),
        }
      : null,
  };

  return { manifest, review };
}

export async function applyWorkshopManifest(input: {
  userId: string;
  manifestYaml: string;
} & WorkCommandMeta): Promise<ApplyWorkshopManifestResult> {
  let prepared: Awaited<ReturnType<typeof reviewWorkshopManifest>>;
  return runWorkLifecycleCommand({ownerId: input.userId, type: "createWorkFromManifest", command: input,
    prepare: async () => {
      // YAML/capability validation is read-only. Name uniqueness is checked under
      // the owner lock when applying, including concurrent different commands.
      prepared = await reviewWorkshopManifest({...input, existingWorkshops: []});
      if (!prepared.review.ok) throw new WorkCommandConflict("invalid_command");
    },
  }, async (persisted, context, workId) => applyNewManifest(persisted, prepared!, context, workId));
}

async function applyNewManifest(input: Parameters<typeof applyWorkshopManifest>[0],
  {manifest, review}: Awaited<ReturnType<typeof reviewWorkshopManifest>>, context: WorkshopWriteContext, workId: string): Promise<ApplyWorkshopManifestResult> {
  if (!review.ok) {
    throw new Error(
      `Workshop manifest review failed: ${review.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const spec = recordAt(manifest, "spec");
  const patch = workshopPatchFromManifest(manifest);
  // Serialize this owner's manifest namespace while allowing foreign-key KEY
  // SHARE locks held by concurrently accepted commands. FOR UPDATE deadlocks.
  await context.db.execute(sql`SELECT id FROM "User" WHERE id=${input.userId}::uuid FOR NO KEY UPDATE`);
  if (review.manifestName && (await listWorkshops(input.userId, 1, {manifestName: review.manifestName}, context.db)).length) throw new WorkCommandConflict("manifest_conflict");
  const workshop = await createWorkshop({
    userId: input.userId,
    ...patch,
  }, context, workId);

  let createdSources = 0;
  for (const source of arrayAt(spec, "sources").filter(isRecord)) {
    const rawType = stringAt(source, "type");
    const type =
      rawType === "memory" || rawType === "channel"
        ? "manual"
        : sourceType(rawType);
    if (!type) continue;
    await addWorkshopSource({
      workshopId: workshop.id,
      type,
      name: stringAt(source, "name"),
      uri: stringAt(source, "uri") || null,
      content: stringAt(source, "purpose") || stringAt(source, "query") || null,
      config: asWorkshopJson({
        ...source,
        manifestSourceType: rawType,
      }),
    }, context);
    createdSources += 1;
  }

  let createdLoops = 0;
  for (const loop of arrayAt(spec, "loops").filter(isRecord)) {
    await createLoop({
      userId: input.userId,
      workshopId: workshop.id,
      ...loopPatchFromManifest(loop),
      initialState: {
        currentPhase: "idle",
        lastObservation: "Loop created from Workshop manifest.",
        nextAction: "Waiting for the next scheduled run or manual execution.",
        stateJson: {
          workshopId: workshop.id,
          manifestName: review.manifestName,
          manifestLoopName: stringAt(loop, "name"),
          skill: stringAt(loop, "skill"),
        },
      },
    }, context.db);
    createdLoops += 1;
  }

  await context.append({
    workshopId: workshop.id,
    type: "workshop_manifest_applied",
    title: review.creationReport?.title || "Workshop manifest applied",
    body:
      review.creationReport?.body ||
      `Created ${createdLoops} loop(s) and ${createdSources} source(s) from ${review.manifestName}.`,
    metadata: {
      manifestName: review.manifestName,
      manifestTitle: review.title,
      review,
      created: {
        loops: createdLoops,
        sources: createdSources,
      },
    },
  });

  return {
    workshop,
    review,
    created: {
      sources: createdSources,
      loops: createdLoops,
    },
  };
}

export async function applyWorkshopManifestToExisting(input: {
  userId: string;
  workshopId: string;
  manifestYaml: string;
} & WorkCommandMeta): Promise<ApplyWorkshopManifestToExistingResult> {
  const existingWorkshop = await getWorkshop(input.userId, input.workshopId);
  if (!existingWorkshop) {
    throw new Error("Workshop not found.");
  }

  return runPreparedDatabaseWorkCommand({...input, workId: input.workshopId}, "applyWorkManifest", async persisted => {
    const prepared = await reviewWorkshopManifest({userId: persisted.userId, manifestYaml: persisted.manifestYaml, allowExistingWorkshopId: persisted.workId});
    if (!prepared.review.ok) throw new WorkCommandConflict("invalid_command");
    return prepared;
  }, applyExistingManifest);
}

async function applyExistingManifest(input: Parameters<typeof applyWorkshopManifestToExisting>[0],
  {manifest, review}: Awaited<ReturnType<typeof reviewWorkshopManifest>>, context: WorkshopWriteContext): Promise<ApplyWorkshopManifestToExistingResult> {
  if (!review.ok) {
    throw new Error(
      `Workshop manifest review failed: ${review.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  await context.db.execute(sql`SELECT id FROM "User" WHERE id=${input.userId}::uuid FOR NO KEY UPDATE`);
  if (review.manifestName && (await listWorkshops(input.userId, 1, {manifestName: review.manifestName, excludeId: input.workshopId}, context.db)).length) throw new WorkCommandConflict("manifest_conflict");

  const spec = recordAt(manifest, "spec");
  const workshopPatch = workshopPatchFromManifest(manifest);
  const workshop = await updateWorkshop(input.userId, input.workshopId, {
    ...workshopPatch,
    changeSource: "manifest_update",
  }, context);
  if (!workshop) {
    throw new Error("Workshop not found.");
  }

  const existingLoops = await listLoopsForWorkshop({
    userId: input.userId,
    workshopId: input.workshopId,
    names: arrayAt(spec, "loops").filter(isRecord).flatMap(loop => [stringAt(loop, "name"), loopNameFromManifest(loop)]),
    manifestNames: arrayAt(spec, "loops").filter(isRecord).map(loop => stringAt(loop, "name")),
    limit: arrayAt(spec, "loops").length * 4 + 1,
  }, context.db);
  if (existingLoops.length >= arrayAt(spec, "loops").length * 4 + 1) throw new WorkCommandConflict("ambiguous_target");
  const loopsByName = new Map(existingLoops.map((loop) => [loop.name, loop]));
  if (loopsByName.size !== existingLoops.length) throw new WorkCommandConflict("ambiguous_target");
  const loopsByManifestName = new Map<string, typeof existingLoops[number]>();
  const stateByLoop = new Map<string, Awaited<ReturnType<typeof getLoopState>>>();
  for (const loop of existingLoops) {
    const state = await getLoopState(loop.id, context.db);
    stateByLoop.set(loop.id, state);
    const identity = state?.stateJson?.manifestLoopName;
    if (typeof identity === "string" && identity) {
      if (loopsByManifestName.has(identity)) throw new WorkCommandConflict("ambiguous_target");
      loopsByManifestName.set(identity, loop);
    }
  }

  let createdLoops = 0;
  let updatedLoops = 0;
  for (const loop of arrayAt(spec, "loops").filter(isRecord)) {
    const manifestLoopName = stringAt(loop, "name");
    const displayName = loopNameFromManifest(loop);
    const candidates = [loopsByManifestName.get(manifestLoopName), loopsByName.get(manifestLoopName), loopsByName.get(displayName)].filter(Boolean);
    if (new Set(candidates.map(candidate => candidate!.id)).size > 1) throw new WorkCommandConflict("ambiguous_target");
    const existingLoop = candidates[0];
    const oldIdentity = existingLoop ? stateByLoop.get(existingLoop.id)?.stateJson?.manifestLoopName : undefined;
    if (oldIdentity && oldIdentity !== manifestLoopName) throw new WorkCommandConflict("ambiguous_target");
    const patch = loopPatchFromManifest(loop);

    if (existingLoop) {
      await applyUpdateWorkLoop({userId: input.userId, workId: input.workshopId, loopId: existingLoop.id,
        commandId: input.commandId, source: input.source ?? "owner", reason: "Manifest update", patch}, context);
      const state = await getLoopState(existingLoop.id, context.db);
      await upsertLoopState(existingLoop.id, {stateJson: {...(state?.stateJson ?? {}),
        manifestName: review.manifestName, manifestLoopName, skill: stringAt(loop, "skill")}}, context.db);
      updatedLoops += 1;
      continue;
    }

    const created = await createLoop({
      userId: input.userId,
      workshopId: input.workshopId,
      ...patch,
      initialState: {
        currentPhase: "idle",
        lastObservation: "Loop created from Workshop manifest update.",
        nextAction: "Waiting for the next scheduled run or manual execution.",
        stateJson: {
          workshopId: input.workshopId,
          manifestName: review.manifestName,
          manifestLoopName,
          skill: stringAt(loop, "skill"),
        },
      },
    }, context.db);
    loopsByName.set(created.name, created);
    createdLoops += 1;
  }

  const existingSources = await listWorkshopSourceNames(input.workshopId, arrayAt(spec, "sources").filter(isRecord).map(source => stringAt(source, "name")), context.db);
  const existingSourceNames = new Set(
    existingSources.map((source: { name: string }) => source.name),
  );
  let createdSources = 0;
  for (const source of arrayAt(spec, "sources").filter(isRecord)) {
    const name = stringAt(source, "name");
    if (!name || existingSourceNames.has(name)) continue;

    const rawType = stringAt(source, "type");
    const type =
      rawType === "memory" || rawType === "channel"
        ? "manual"
        : sourceType(rawType);
    if (!type) continue;
    await addWorkshopSource({
      workshopId: input.workshopId,
      type,
      name,
      uri: stringAt(source, "uri") || null,
      content: stringAt(source, "purpose") || stringAt(source, "query") || null,
      config: asWorkshopJson({
        ...source,
        manifestSourceType: rawType,
      }),
    }, context);
    existingSourceNames.add(name);
    createdSources += 1;
  }

  await context.append({
    workshopId: input.workshopId,
    type: "workshop_manifest_applied",
    title: review.creationReport?.title || "Workshop manifest updated",
    body:
      review.creationReport?.body ||
      `Updated ${updatedLoops} loop(s), created ${createdLoops} loop(s), and created ${createdSources} source(s) from ${review.manifestName}.`,
    metadata: {
      manifestName: review.manifestName,
      manifestTitle: review.title,
      review,
      appliedToExistingWorkshop: true,
      updated: {
        workshop: true,
        loops: updatedLoops,
        sources: 0,
      },
      created: {
        loops: createdLoops,
        sources: createdSources,
      },
    },
  });

  return {
    workshop,
    review,
    updated: {
      workshop: true,
      loops: updatedLoops,
      sources: 0,
    },
    created: {
      loops: createdLoops,
      sources: createdSources,
    },
  };
}
