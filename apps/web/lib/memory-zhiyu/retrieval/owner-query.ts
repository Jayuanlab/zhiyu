import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, lt, or } from "drizzle-orm";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { brainMemories, user } from "@/lib/db/schema";
import { memoryReadReceipts } from "@/lib/db/schema.pg";
import { memoryInvalid, MemoryModuleError } from "@/lib/memory/kernel/errors";
import { memoryFromRow } from "@/lib/memory/records/memory-record";
import {
	stableJson,
	observationVersion,
} from "@/lib/memory/records/observations";
import { readCurrentState } from "@/lib/memory/records/current-state";
import { readObservation } from "@/lib/memory/adapters/postgres/observations";
import { appendQueryReceipt } from "@/lib/memory/adapters/postgres/query-receipts";
import { observationIdFromEvidenceRef } from "@/lib/memory/evidence/references";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { buildBrainContextFromMemoryRequest } from "@/lib/memory/retrieval/recall";
import { finalizeContextPack } from "@/lib/memory/context/finalize";
import {
	budgetContextPack,
	negotiateContextPack,
} from "@/lib/memory/context/budget";
import type { BrainContextPack } from "@/lib/memory/context/pack";
import type { MemoryResultMeta, StateRecordRef } from "@/lib/memory/contracts";
import type {
	BrainMemory,
	BrainMemoryStatus,
	BrainMemoryType,
} from "@/lib/memory/kernel/memory-types";
import type { InformationNeed } from "@/lib/memory/retrieval/information-needs";
import type {
	ContextEntry,
	ContextRecallReadQuery,
	DiscoveryReadQuery,
	MemoryContextPack,
	MemoryQueryReadResult,
	QueryVersionRef,
} from "@/lib/memory/query-contracts";

const digest = (value: unknown) =>
	createHash("sha256").update(stableJson(value)).digest("hex");
const memoryTypes = [
	"fact",
	"preference",
	"plan",
	"boundary",
	"relationship",
	"task",
	"insight",
	"system",
];
const statuses = [
	"candidate",
	"active",
	"verified",
	"weakened",
	"superseded",
	"deleted",
];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function obj(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		memoryInvalid("A query object is required");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		memoryInvalid("Unexpected query field");
}
function text(value: unknown, max: number) {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		memoryInvalid("Invalid query text");
	return value.trim();
}
function integer(value: unknown, fallback: number, min: number, max: number) {
	if (value === undefined) return fallback;
	if (
		!Number.isSafeInteger(value) ||
		Number(value) < min ||
		Number(value) > max
	)
		memoryInvalid("Invalid query budget");
	return Number(value);
}
function enumeration(value: unknown, allowed: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		!value.length ||
		value.length > allowed.length ||
		value.some((item) => typeof item !== "string" || !allowed.includes(item))
	)
		memoryInvalid("Invalid query filter");
	return [...new Set(value)] as string[];
}
function parse(value: unknown): DiscoveryReadQuery | ContextRecallReadQuery {
	const query = obj(value);
	if (query.purpose === "discover") {
		keys(query, ["purpose", "query", "filters", "limit", "cursor"]);
		const filter = query.filters === undefined ? {} : obj(query.filters);
		keys(filter, ["memoryTypes", "statuses"]);
		return {
			purpose: "discover",
			query: text(query.query, 2000),
			limit: integer(query.limit, 20, 1, 100),
			...(query.cursor === undefined
				? {}
				: { cursor: text(query.cursor, 2048) }),
			filters: {
				memoryTypes: enumeration(filter.memoryTypes, memoryTypes) as
					| BrainMemoryType[]
					| undefined,
				statuses: enumeration(filter.statuses, statuses) as
					| BrainMemoryStatus[]
					| undefined,
			},
		};
	}
	if (query.purpose !== "recall") memoryInvalid("Invalid query purpose");
	keys(query, [
		"purpose",
		"taskIntent",
		"needs",
		"maxTokens",
		"budget",
		"currentRefs",
	]);
	let budget: ContextRecallReadQuery["budget"];
	if (query.budget !== undefined) {
		if (query.maxTokens !== undefined)
			memoryInvalid("Choose a fixed budget or explicit bounded negotiation");
		const value = obj(query.budget);
		keys(value, ["preferredBytes", "ceilingBytes"]);
		if (value.preferredBytes === undefined || value.ceilingBytes === undefined)
			memoryInvalid("Both preferred and ceiling byte budgets are required");
		const preferredBytes = integer(value.preferredBytes, 8192, 1024, 8192),
			ceilingBytes = integer(value.ceilingBytes, 65536, preferredBytes, 65536);
		budget = { preferredBytes, ceilingBytes };
	}
	let needs: InformationNeed[] | undefined;
	if (query.needs !== undefined) {
		if (!Array.isArray(query.needs) || query.needs.length > 24)
			memoryInvalid("Invalid information needs");
		needs = query.needs.map((value) => {
			const need = obj(value);
			keys(need, [
				"id",
				"category",
				"question",
				"required",
				"matchTerms",
				"maxAgeHours",
			]);
			if (
				typeof need.category !== "string" ||
				![
					"platform",
					"tools",
					"user",
					"task",
					"knowledge",
					"experience",
				].includes(need.category) ||
				typeof need.required !== "boolean"
			)
				memoryInvalid("Invalid information need");
			if (
				need.maxAgeHours !== undefined &&
				(typeof need.maxAgeHours !== "number" ||
					!Number.isFinite(need.maxAgeHours) ||
					need.maxAgeHours < 0 ||
					need.maxAgeHours > 87600)
			)
				memoryInvalid("Invalid freshness bound");
			const matchTerms = need.matchTerms;
			if (
				matchTerms !== undefined &&
				(!Array.isArray(matchTerms) ||
					matchTerms.length > 24 ||
					matchTerms.some(
						(item) =>
							typeof item !== "string" || !item.trim() || item.length > 200,
					))
			)
				memoryInvalid("Invalid matching terms");
			return {
				id: text(need.id, 100),
				category: need.category as InformationNeed["category"],
				question: text(need.question, 1000),
				required: need.required,
				...(matchTerms ? { matchTerms: matchTerms as string[] } : {}),
				...(need.maxAgeHours === undefined
					? {}
					: { maxAgeHours: need.maxAgeHours as number }),
			};
		});
		if (new Set(needs.map((need) => need.id)).size !== needs.length)
			memoryInvalid("Duplicate information need IDs");
	}
	let currentRefs: StateRecordRef[] | undefined;
	if (query.currentRefs !== undefined) {
		if (!Array.isArray(query.currentRefs) || query.currentRefs.length > 8)
			memoryInvalid("Invalid current references");
		currentRefs = query.currentRefs.map((value) => {
			const ref = obj(value);
			if (ref.kind === "interaction_task") {
				keys(ref, ["kind", "id"]);
				if (typeof ref.id !== "string" || !uuid.test(ref.id))
					memoryInvalid("Invalid current task reference");
			} else if (ref.kind === "scenario_state") {
				keys(ref, ["kind", "scenarioType", "scenarioKey"]);
				text(ref.scenarioType, 100);
				text(ref.scenarioKey, 300);
			} else memoryInvalid("Unsupported current reference");
			return ref as StateRecordRef;
		});
	}
	return {
		purpose: "recall",
		taskIntent: text(query.taskIntent, 4000),
		needs,
		currentRefs,
		...(budget
			? { budget }
			: { maxTokens: integer(query.maxTokens, 4096, 1024, 8192) }),
	};
}
function meta(detail: string): MemoryResultMeta {
	return {
		traceId: randomUUID(),
		contractVersion: "memory-query.v1",
		implementationVersion: "memory-t4.v1",
		provider: "postgres",
		detail,
		warnings: [],
	};
}
async function lockOwner(userId: string) {
	const [principal] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.id, userId))
		.for("share");
	if (!principal)
		throw new MemoryModuleError(
			"memory_access_denied",
			403,
			"Owner identity unavailable",
		);
}
async function discover(
	userId: string,
	query: DiscoveryReadQuery,
): Promise<MemoryQueryReadResult> {
	const resultMeta = meta("owner_saved_memory_discovery"),
		limit = query.limit ?? 20;
	const queryHash = digest({
		userId,
		query: query.query,
		filters: query.filters,
		limit,
	});
	let cursor: { id: string; updatedAt: string } | undefined;
	if (query.cursor) {
		try {
			const value = JSON.parse(
				Buffer.from(query.cursor, "base64url").toString("utf8"),
			);
			if (
				value.queryHash !== queryHash ||
				typeof value.id !== "string" ||
				!uuid.test(value.id) ||
				typeof value.updatedAt !== "string" ||
				!Number.isFinite(Date.parse(value.updatedAt))
			)
				memoryInvalid("Invalid discovery cursor");
			cursor = { id: value.id, updatedAt: value.updatedAt };
		} catch {
			memoryInvalid("Invalid discovery cursor");
		}
	}
	return withDatabaseTransaction(async () => {
		await lockOwner(userId);
		const pattern = `%${query.query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
		const selected = await db
			.select()
			.from(brainMemories)
			.where(
				and(
					eq(brainMemories.userId, userId),
					inArray(
						brainMemories.status,
						query.filters?.statuses ?? [
							"candidate",
							"active",
							"verified",
							"weakened",
						],
					),
					query.filters?.memoryTypes
						? inArray(brainMemories.memoryType, query.filters.memoryTypes)
						: undefined,
					or(
						ilike(brainMemories.subject, pattern),
						ilike(brainMemories.content, pattern),
					),
					cursor
						? or(
								lt(brainMemories.updatedAt, new Date(cursor.updatedAt)),
								and(
									eq(brainMemories.updatedAt, new Date(cursor.updatedAt)),
									lt(brainMemories.id, cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(brainMemories.updatedAt), desc(brainMemories.id))
			.limit(limit + 1)
			.for("share");
		const rows: BrainMemory[] = selected.slice(0, limit).map(memoryFromRow);
		const refs: QueryVersionRef[] = rows.map((row) => ({
			record: { kind: "memory", id: row.id },
			revision: getBrainMemoryRevisionVersion(row),
		}));
		const coverage = {
			recordKinds: ["memory"] as ["memory"],
			complete: false as const,
			limit,
		};
		const receipt = await appendQueryReceipt(db, {
			userId,
			purpose: "discover",
			requestHash: digest(query),
			refs,
			coverage,
			meta: resultMeta,
		});
		const last = rows.at(-1);
		resultMeta.warnings.push(
			"Discovery is a live, bounded saved-memory search; results are not task context or independent verification",
		);
		return {
			status: rows.length ? "ok" : "empty",
			purpose: "discover",
			receipt,
			meta: resultMeta,
			coverage,
			items: rows.map((row, i) => ({
				id: row.id,
				subject: row.subject,
				content: Array.from(row.content).slice(0, 600).join(""),
				memoryType: row.memoryType,
				status: row.status,
				ref: refs[i],
				evidenceRefs: row.evidenceRefs,
				updatedAt: row.updatedAt,
				expiresAt: row.expiresAt,
				truncated: Array.from(row.content).length > 600,
				useSemantics: "discovery_only",
				receipt,
			})),
			nextCursor:
				selected.length > limit && last
					? Buffer.from(
							JSON.stringify({
								queryHash,
								id: last.id,
								updatedAt: last.updatedAt,
							}),
						).toString("base64url")
					: null,
		};
	});
}
function entry(
	item: BrainContextPack["items"][number],
	receiptId: string,
): ContextEntry {
	if (!item.revisionVersion)
		throw new Error("Current context item requires a stored version");
	return {
		ref: {
			record: { kind: "memory", id: item.id },
			revision: item.revisionVersion,
		},
		subject: item.subject,
		content: item.content,
		useSemantics:
			item.memoryType === "boundary"
				? "safety_constraint"
				: "saved_interpretation",
		evidenceRefs: item.evidenceRefs,
		freshness: {
			asOf: item.freshness?.updatedAt ?? new Date().toISOString(),
			observedAt: item.freshness?.observedAt,
			basis: item.freshness?.basis ?? "unknown",
		},
		receipt: { id: receiptId, kind: "context_admission" },
		...(item.reasons.includes("budget_truncated")
			? { truncated: true, truncationReason: "context_budget" }
			: {}),
	};
}
async function recall(
	userId: string,
	query: ContextRecallReadQuery,
): Promise<MemoryQueryReadResult> {
	const resultMeta = meta("owner_task_context_recall"),
		requester = { type: "chat" as const, userId, id: "memory-owner-query" };
	// Network/model planning and attempts remain outside the final short transaction.
	const prepared = await buildBrainContextFromMemoryRequest({
		requester,
		taskIntent: query.taskIntent,
		informationNeeds: query.needs,
		planningMode: "rules",
		accessMode: "owner_override",
		discoverySources: [],
		maxItems: 24,
		memoryLimit: 200,
		platformState: {
			platform: "chat",
			phase: "owner_memory_recall",
			riskLevel: "normal",
		},
		action: { kind: "answer" },
	});
	return withDatabaseTransaction(async () => {
		await lockOwner(userId);
		const currentStates: ContextEntry[] = [],
			historicalEvidence: ContextEntry[] = [];
		const openQuestions: MemoryContextPack["openQuestions"] = [];
		for (const ref of query.currentRefs ?? []) {
			const state = await readCurrentState(userId, ref);
			if (state.status !== "ok") {
				openQuestions.push({
					code: state.code,
					detail: "An explicitly requested current state is unavailable",
				});
				continue;
			}
			currentStates.push({
				ref: state.ref,
				subject: ref.kind,
				content: JSON.stringify(state.record),
				useSemantics:
					ref.kind === "interaction_task"
						? "authoritative_current_state"
						: "saved_interpretation",
				freshness: {
					asOf: new Date().toISOString(),
					basis:
						ref.kind === "interaction_task"
							? "authoritative_record"
							: "saved_scenario_estimate",
				},
				receipt: { id: state.receipt.id, kind: "current_state_read" },
			});
		}
		const sourceRefs = [
			...new Set(prepared.items.flatMap((item) => item.evidenceRefs)),
		].slice(0, 16);
		for (const sourceRef of sourceRefs) {
			const sourceId = observationIdFromEvidenceRef(sourceRef);
			if (!sourceId) {
				openQuestions.push({
					code: "exact_source_history_unavailable",
					detail:
						"A source pointer has no supported fixed observation version; expand it through its domain reader",
				});
				continue;
			}
			const observation = await readObservation(db, userId, sourceId);
			if (!observation) {
				openQuestions.push({
					code: "evidence_unavailable",
					detail: "A selected observation is unavailable",
				});
				continue;
			}
			const fixed = observationVersion(observation),
				chars = Array.from(observation.content),
				content = chars.slice(0, 512).join("");
			historicalEvidence.push({
				ref: fixed,
				subject: observation.sourceType,
				content,
				useSemantics: "raw_observation",
				freshness: {
					asOf: new Date().toISOString(),
					observedAt: observation.observedAt,
					basis: "observation",
				},
				receipt: {
					id: "00000000-0000-0000-0000-000000000000",
					kind: "observation_evidence_read",
				},
				evidenceRefs: [sourceRef],
				...(chars.length > 512
					? { truncated: true, truncationReason: "evidence_window" }
					: {}),
			});
		}
		for (const item of prepared.informationReadiness?.needs ?? [])
			if (
				[
					"missing",
					"unverified",
					"stale",
					"conflict",
					"denied",
					"unavailable",
				].includes(item.status)
			)
				openQuestions.push({
					code: `information_${item.status}`,
					detail: item.question,
				});
		const provisional: MemoryContextPack = {
			interfaceVersion: "memory-context.v1",
			contextLogId: prepared.contextLogId ?? "pending",
			constraints: prepared.items
				.filter((item) => item.memoryType === "boundary")
				.map((item) => entry(item, prepared.contextLogId ?? "pending")),
			interpretations: prepared.items
				.filter((item) => item.memoryType !== "boundary")
				.map((item) => entry(item, prepared.contextLogId ?? "pending")),
			currentStates,
			historicalEvidence,
			openQuestions,
			budget: {
				maxTokens: query.budget?.preferredBytes ?? query.maxTokens ?? 4096,
				usedUpperBound: 0,
				unit: "utf8_bytes_upper_bound",
				truncated: false,
			},
			coverage: {
				discovery: false,
				candidateCoverage: "bounded",
				dependencyCoverage: "registered_edges_only",
				independentBusinessVerification: false,
				exactHistoricalEvidence: "observation_only",
			},
		};
		const negotiated = query.budget
			? negotiateContextPack(provisional, {
					ceilingBytes: query.budget.ceilingBytes,
					reservedBytes: 1024,
				})
			: undefined;
		const budgeted = negotiated
			? negotiated.pack
			: budgetContextPack(provisional, 256);
		if (!budgeted)
			return {
				status: "unavailable",
				purpose: "recall",
				code: "memory_context_budget_insufficient",
				meta: {
					...resultMeta,
					warnings: [
						"The complete selected safety constraints do not fit the requested budget",
					],
				},
				...(negotiated
					? {
							budget: {
								requiredBytes: negotiated.requiredBytes,
								ceilingBytes: query.budget!.ceilingBytes,
								constraintCount: provisional.constraints.length,
							},
						}
					: {}),
			};
		const retainedEntries = [
			...budgeted.constraints,
			...budgeted.interpretations,
		];
		const byId = new Map(
			retainedEntries.map((item) => [
				"id" in item.ref.record ? item.ref.record.id : "",
				item,
			]),
		);
		const selected: BrainContextPack = {
			...prepared,
			items: prepared.items.flatMap((item) => {
				const retained = byId.get(item.id);
				return retained
					? [
							{
								...item,
								content: retained.content,
								reasons: [
									...item.reasons,
									...(retained.truncated ? ["budget_truncated"] : []),
								],
							},
						]
					: [];
			}),
		};
		const final = await finalizeContextPack({
			requester,
			pack: selected,
			taskIntent: query.taskIntent,
			accessMode: "owner_override",
			metadata: { source: "owner_recall_final", budget: budgeted.budget },
		});
		if (!final.contextLogId)
			throw new Error("Final context admission audit is required");
		const currentIds = new Set(final.items.map((item) => item.id)),
			allowedEvidence = new Set(
				final.items.flatMap((item) => item.evidenceRefs),
			);
		if (
			query.budget &&
			budgeted.constraints.some(
				(item) =>
					!("id" in item.ref.record) || !currentIds.has(item.ref.record.id!),
			)
		)
			return {
				status: "unavailable",
				purpose: "recall",
				code: "memory_context_changed",
				meta: {
					...resultMeta,
					warnings: [
						"A selected safety constraint changed during final admission; no partial safety context was returned",
					],
				},
			};
		const finalPack: MemoryContextPack = {
			...budgeted,
			contextLogId: final.contextLogId,
			constraints: budgeted.constraints
				.filter(
					(item) =>
						"id" in item.ref.record && currentIds.has(item.ref.record.id!),
				)
				.map((item) => ({
					...item,
					receipt: { id: final.contextLogId!, kind: "context_admission" },
				})),
			interpretations: budgeted.interpretations
				.filter(
					(item) =>
						"id" in item.ref.record && currentIds.has(item.ref.record.id!),
				)
				.map((item) => ({
					...item,
					receipt: { id: final.contextLogId!, kind: "context_admission" },
				})),
			historicalEvidence: budgeted.historicalEvidence.filter((item) =>
				item.evidenceRefs?.some((ref) => allowedEvidence.has(ref)),
			),
		};
		const finalWarnings = [
			...(prepared.warnings ?? []),
			...(final.warnings ?? []),
		];
		if (finalWarnings.length) {
			finalPack.openQuestions = [
				...finalPack.openQuestions,
				{
					code: finalWarnings.some(
						(item) => item.code === "memory_update_pending",
					)
						? "memory_update_pending"
						: "final_context_warning",
					detail:
						"本次上下文仍有未核实来源、待审更新或适用性缺口，请核对当前记录和原始来源后再使用。",
				},
			];
			resultMeta.warnings.push(
				...[...new Set(finalWarnings.map((item) => item.code))].map(
					(code) => `context_warning:${code}`,
				),
			);
		}
		for (const item of finalPack.historicalEvidence) {
			const observationId =
				"id" in item.ref.record ? item.ref.record.id : undefined;
			const observation = observationId
				? await readObservation(db, userId, observationId)
				: null;
			if (!observation)
				throw new Error("Selected immutable observation became unavailable");
			const [saved] = await db
				.insert(memoryReadReceipts)
				.values({
					id: randomUUID(),
					userId,
					purpose: "evidence",
					observationId: observation.id,
					revision: item.ref.revision,
					actualRange: {
						start: 0,
						end: Array.from(item.content).length,
						unit: "unicode_code_points",
					},
					totalLength: Array.from(observation.content).length,
					traceId: resultMeta.traceId,
					contractVersion: resultMeta.contractVersion,
					implementationVersion: resultMeta.implementationVersion,
				})
				.returning();
			if (!saved)
				throw new Error("Context observation read receipt was not persisted");
			item.receipt.id = saved.id;
		}
		const fitted = finalPack;
		fitted.budget.usedUpperBound =
			Buffer.byteLength(JSON.stringify(fitted), "utf8") + 16;
		if (fitted.budget.usedUpperBound > fitted.budget.maxTokens)
			throw new Error("Final context exceeds its verified budget");
		const refs = [
			...fitted.currentStates,
			...fitted.historicalEvidence,
			...fitted.constraints,
			...fitted.interpretations,
		].map((item) => item.ref);
		const receipt = await appendQueryReceipt(db, {
			userId,
			purpose: "recall",
			requestHash: digest(query),
			refs,
			contextLogId: final.contextLogId,
			coverage: fitted.coverage,
			meta: resultMeta,
		});
		resultMeta.warnings.push(
			"Context is a bounded state estimate and does not grant action permission; current business judgments require authoritative current-state references",
		);
		if (prepared.recallPlan.warnings?.length)
			resultMeta.warnings.push(...prepared.recallPlan.warnings.slice(0, 8));
		if (final.items.length < selected.items.length)
			resultMeta.warnings.push(
				"Some selected versions changed or became unavailable during final admission and were withheld",
			);
		return {
			status: refs.length ? "ok" : "empty",
			purpose: "recall",
			pack: fitted,
			receipt,
			meta: resultMeta,
		};
	});
}
export async function readOwnerMemoryQuery(
	userId: string,
	value: unknown,
): Promise<MemoryQueryReadResult> {
	const query = parse(value);
	return query.purpose === "discover"
		? discover(userId, query)
		: recall(userId, query);
}
