import type { Workshop } from "@/lib/db/schema";
import { getWorkModelSnapshot, listWorks } from "@/lib/work-runtime";
import { getWorkshop, listWorkshops } from "@/lib/workshops/service";
import type { WorkshopWorkModel } from "@/lib/workshops/work-model";
import { admitExactPublishedRecordUse } from "@/lib/memory/context/exact-use";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_FIELD = /api.?key|authorization|credential|password|secret|token|cookie|private.?key/i;
const DISCOVERY_LIMIT = 100;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function redactPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPrivateFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELD.test(key))
    .map(([key, item]) => [key, redactPrivateFields(item)]));
}

function fields(value: unknown, names: readonly string[]) {
  const source = record(value);
  return Object.fromEntries(names.filter(name => Object.hasOwn(source, name))
    .map(name => [name, redactPrivateFields(source[name])]));
}

/** Configuration is a typed public summary, never a copy of provider configuration. */
function configurationSummary(value: unknown, names: readonly string[]) {
  const source = record(value);
  const summary: Record<string, unknown> = {};
  for (const name of names) {
    const item = source[name];
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      summary[name] = item;
    } else if (Array.isArray(item)) {
      summary[name] = item.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return summary;
}

const WORK_FIELDS = {
  manifest: ["id", "name", "role", "mission", "status", "autonomyLevel", "version", "updatedAt"],
  controlContract: ["controlledObjects", "observations", "allowedActions", "approvalRequiredActions", "deniedActions", "boundaryMode", "externalMessagePolicy", "feedbackSignals", "conflicts"],
  skillBindings: ["primarySkills", "loopSkillMap", "availableSkills", "missingSkills"],
  memoryPolicy: ["defaultReadableKinds", "evidenceRequiredForHighImpact", "writeReusableFindingsToMemory", "recallProfiles"],
  artifactPolicy: ["eventTypes", "proposalTypes", "outboxEnabled"],
  presentationContract: ["audience", "reportFormat", "purpose", "requiredSections", "expectedArtifacts", "evidenceSource", "artifactSource", "statusSource", "source"],
  feedback: ["nextWakeupAt", "heartbeatStatus", "pendingReviewSurfaces", "feedbackSignals"],
  observability: ["missing", "warnings"],
  runtime: ["engine", "source", "piGreyReadiness"],
  changeControl: ["proposalSurface", "highRiskChanges", "mediumRiskChanges", "lowRiskChanges"],
} as const;

function publicWorkModel(work: WorkshopWorkModel): WorkshopWorkModel {
  const source = record(work);
  return {
    ...Object.fromEntries(Object.entries(WORK_FIELDS).map(([key, names]) => [key, fields(source[key], names)])),
    loopBindings: Array.isArray(source.loopBindings) ? source.loopBindings.map(item => fields(item,
      ["id", "name", "status", "triggerType", "nextScheduledRunAt", "requiredFields", "skillName", "skillStatus", "hasActionPolicy", "hasVerification"])) : [],
  } as unknown as WorkshopWorkModel;
}

function compactWorkshopForAgent(workshop: Workshop) {
  return {
    id: workshop.id,
    name: workshop.name,
    mission: workshop.mission,
    status: workshop.status,
    autonomyLevel: workshop.autonomyLevel,
    boundaryPolicy: configurationSummary(workshop.boundaryPolicy,
      ["mode", "externalMessages", "realTrading", "payments", "deletion", "configurationChanges", "allowed", "denied", "requiresApproval"]),
    modelConfig: configurationSummary(workshop.modelConfig,
      ["role", "persona", "workVersion", "model", "agentModel", "agentRuntimeEngine", "runtimeEngine", "piModelProtocol", "piProtocol", "temperature",
        "primarySkills", "allowedTools", "primaryTools", "deniedTools", "disallowedTools", "requiresApprovalTools", "requiresApproval", "controlledObjects", "observationTools", "feedbackSignals"]),
    updatedAt: workshop.updatedAt,
  };
}

type WorkshopInspectionInput = {
  userId: string;
  workshopId?: string;
  workshopName?: string;
};

async function readWorkshopInspection(input: WorkshopInspectionInput) {
  const workList = await listWorks({
    userId: input.userId,
    limit: DISCOVERY_LIMIT,
  });
  const workshops = workList.works.map((item) => item.workshop).filter(item => item.userId === input.userId) as Workshop[];
  const name = input.workshopName?.trim();
  let target: Workshop | null = null;
  let targetResolution: "not_requested" | "unique" | "not_found" | "ambiguous" | "conflicting_reference" | "invalid_reference" = "not_requested";
  if (input.workshopId !== undefined) {
    if (!UUID.test(input.workshopId)) targetResolution = "invalid_reference";
    else {
      const candidate = await getWorkshop(input.userId, input.workshopId);
      if (!candidate || candidate.userId !== input.userId || candidate.id.toLowerCase() !== input.workshopId.toLowerCase()) targetResolution = "not_found";
      else if (name !== undefined && candidate.name !== name) targetResolution = "conflicting_reference";
      else { target = candidate; targetResolution = "unique"; }
    }
  } else if (name !== undefined) {
    const matches = name ? (await listWorkshops(input.userId, 2, { exactName: name }))
      .filter((item: Workshop) => item.userId === input.userId && item.name === name) : [];
    targetResolution = matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "not_found";
    if (matches.length === 1) target = matches[0];
  }
  const model = target
    ? (await getWorkModelSnapshot({
        userId: input.userId,
        workId: target.id,
      }))?.work ?? null
    : null;
  await admitExactPublishedRecordUse({ userId: input.userId, source: 'workshops', rows: [...workshops, ...(target ? [target] : [])] });
  const work = model ? { ...publicWorkModel(model), loopBindings: [], feedback: {}, observability: {} } : null;

  return {
    ok: true,
    target: target ? compactWorkshopForAgent(target) : null,
    targetResolution,
    work,
    sourceCoverage: { configuration: 'exact_stored_work_version', loopBindings: 'memory_source_unregistered',
      feedback: 'memory_source_unregistered', warning: 'Derived Loop bindings and heartbeat summaries were withheld; use the typed Loop and published record readers.' },
    listingCoverage: { limit: DISCOVERY_LIMIT, returned: workshops.length,
      completeness: workList.works.length >= DISCOVERY_LIMIT ? "partial_or_unknown" : "complete" },
    workshops: workshops.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      autonomyLevel: item.autonomyLevel,
    })),
    instruction:
      "名称仅按完整精确名称定位；多个同名目标须先澄清，不从有限列表首项选择。修改智能体前必须先阅读 work.controlContract、work.skillBindings、work.loopBindings 和 work.changeControl。这里的配置与工具声明不代表当前 provider 实际装载。修改时调用 proposeWorkshopAgentChange，只提交窄 patch；会影响边界、工具、自动化、真实外部动作的变更必须进入主人审核。",
  };
}

export async function inspectWorkshopAgentForUser(input: WorkshopInspectionInput) {
  try {
    return await readWorkshopInspection(input);
  } catch {
    // Configuration/query exceptions are not a safe model-visible projection.
    throw new Error("车间检查暂时不可用；未完成目标与配置核验，请稍后重试或到车间核对。");
  }
}
