import { remoteOwnerOperation } from "@/lib/memory-zhiyu/remote";
import { revisionTransitionIssue } from "../../../../../packages/memory/src/governance";
import { observationToInsertRow as brainObservationToInsertRow } from "@/lib/memory/records/observations";
import { getBrainMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import {
	brainMemories,
	brainMemoryReviews,
	brainObservations,
} from "@/lib/db/schema";
import { getBrainMemoryCanonicalMetadata } from "@/lib/memory/revision/canonical";
import {
	brainMemoryFromRow,
	brainMemoryToInsertRow,
	brainMemoryReviewToInsertRow,
} from "@/lib/memory/records/memory-record";
import { withBrainMemoryTransaction } from "@/lib/memory/revision/transaction";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { recordMemoryChangeInTransaction } from "@/lib/memory/revision/dependencies";
import {
	acquireBrainWriteAdvisoryLock,
	brainWriteRowLockOptions,
	getBrainMemoryCanonicalWriteLockKey,
} from "@/lib/memory/revision/locks";
import type {
	BrainMemory,
	BrainRequester,
} from "@/lib/memory/kernel/memory-types";

export { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";

export type BrainMemoryRevisionOperation =
	| "correct"
	| "supplement"
	| "state_change"
	| "deactivate"
	| "restore";
export type BrainMemoryRevisionAuthority = "owner_statement" | "external_fact";
export type BrainMemoryRevisionRequest = {
	commandId: string;
	expectedVersion: string;
	operation: BrainMemoryRevisionOperation;
	authority: BrainMemoryRevisionAuthority;
	content?: string;
	reason: string;
	evidenceRefs: string[];
	sourceObservedAt?: string | null;
};
type VersionedMemory = BrainMemory & { revisionVersion: string };
export type BrainMemoryRevisionReceipt = {
	id: string;
	commandId: string;
	status: "applied" | "pending_verification";
	effective: boolean;
	previousVersion: string;
	currentVersion: string;
	newVersion: string | null;
	oldMemoryId: string;
	newMemoryId: string | null;
	verificationRequired: boolean;
	createdAt: string;
};
export type BrainMemoryRevisionResult = {
	commandId: string;
	replayed: boolean;
	operation: BrainMemoryRevisionOperation;
	oldMemory: VersionedMemory;
	newMemory: VersionedMemory | null;
	/** Historical command outcome. Read the current memory before further action. */
	receipt: BrainMemoryRevisionReceipt;
};
export type BrainMemoryRevisionHistoryItem = {
	id: string;
	subject: string;
	content: string;
	status: BrainMemory["status"];
	evidenceRefs: string[];
	createdAt: string;
	updatedAt: string;
	reason: string | null;
	revisionVersion: string;
};

export class BrainMemoryRevisionError extends Error {
	constructor(
		readonly code:
			| "invalid_revision"
			| "owner_revision_required"
			| "memory_not_found"
			| "version_conflict"
			| "command_conflict"
			| "memory_inactive"
			| "memory_update_decision_required",
		readonly status: number,
		message: string,
		readonly currentVersion?: string,
	) {
		super(message);
	}
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPERATIONS = new Set([
	"correct",
	"supplement",
	"state_change",
	"deactivate",
	"restore",
]);
const REQUEST_KEYS = new Set([
	"commandId",
	"expectedVersion",
	"operation",
	"authority",
	"content",
	"reason",
	"evidenceRefs",
	"sourceObservedAt",
]);
const OWNER_ACTIVE_TYPES = new Set([
	"preference",
	"relationship",
	"plan",
	"task",
	"insight",
]);
const REVISION_SOURCE = "brain_memory_revision";

function invalid(message: string): never {
	throw new BrainMemoryRevisionError("invalid_revision", 400, message);
}

export function parseBrainMemoryRevisionRequest(
	value: unknown,
): BrainMemoryRevisionRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalid("Invalid revision request");
	const body = value as Record<string, unknown>;
	if (Object.keys(body).some((key) => !REQUEST_KEYS.has(key)))
		invalid("Revision cannot change memory identity, status or metadata");
	if (
		typeof body.commandId !== "string" ||
		!body.commandId.trim() ||
		body.commandId.length > 200
	)
		invalid("commandId must contain 1 to 200 characters");
	if (
		typeof body.expectedVersion !== "string" ||
		!/^bmrv1:[a-f0-9]{64}$/.test(body.expectedVersion)
	)
		invalid("A current expectedVersion is required");
	if (typeof body.operation !== "string" || !OPERATIONS.has(body.operation))
		invalid("Invalid revision operation");
	if (
		body.authority !== "owner_statement" &&
		body.authority !== "external_fact"
	)
		invalid("Invalid revision authority");
	if (
		typeof body.reason !== "string" ||
		!body.reason.trim() ||
		body.reason.length > 4_000
	)
		invalid("reason must contain 1 to 4000 characters");
	if (body.operation === "deactivate") {
		if (body.content !== undefined)
			invalid("Deactivation does not accept replacement content");
	} else if (
		typeof body.content !== "string" ||
		!body.content.trim() ||
		body.content.length > 64_000
	) {
		invalid("Replacement content must contain 1 to 64000 characters");
	}
	const refs = body.evidenceRefs ?? [];
	if (
		!Array.isArray(refs) ||
		refs.length > 101 ||
		refs.some(
			(ref) => typeof ref !== "string" || !ref.trim() || ref.length > 2_048,
		)
	)
		invalid(
			"evidenceRefs must contain at most 101 nonempty references (100 sources and the current owner assertion)",
		);
	if (body.sourceObservedAt !== undefined && body.sourceObservedAt !== null) {
		if (
			body.operation !== "state_change" ||
			typeof body.sourceObservedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
				body.sourceObservedAt,
			) ||
			!Number.isFinite(new Date(body.sourceObservedAt).getTime())
		)
			invalid(
				"sourceObservedAt must be an explicit ISO timestamp for a state change",
			);
	}
	return {
		commandId: body.commandId.trim(),
		expectedVersion: body.expectedVersion,
		operation: body.operation as BrainMemoryRevisionOperation,
		authority: body.authority,
		content: body.content as string | undefined,
		reason: body.reason.trim(),
		evidenceRefs: [...new Set((refs as string[]).map((ref) => ref.trim()))],
		...(body.sourceObservedAt === undefined
			? {}
			: { sourceObservedAt: body.sourceObservedAt as string | null }),
	};
}

function commandRecordId(
	userId: string,
	commandId: string,
	purpose: string,
): string {
	const hash = createHash("sha256")
		.update(
			JSON.stringify([
				"brain-memory-revision.v1",
				userId.toLowerCase(),
				commandId,
				purpose,
			]),
		)
		.digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function versioned(memory: BrainMemory): VersionedMemory {
	return { ...memory, revisionVersion: getBrainMemoryRevisionVersion(memory) };
}

export async function getBrainMemoryForRevision(input: {
	userId: string;
	memoryId: string;
}) {
	if (!UUID.test(input.memoryId)) invalid("Invalid memory ID");
	const memory = await getBrainMemoryById(input);
	if (!memory)
		throw new BrainMemoryRevisionError(
			"memory_not_found",
			404,
			"Brain memory not found",
		);
	const history: BrainMemoryRevisionHistoryItem[] = [];
	const pending = [...(memory.supersedes ?? [])];
	const visited = new Set([memory.id]);
	let historyReads = 0;
	let historyWarning:
		| {
				code:
					| "history_unavailable"
					| "history_identity_mismatch"
					| "history_cycle";
				message: string;
		  }
		| undefined;
	while (pending.length && historyReads < 8) {
		const id = pending.shift()!;
		historyReads++;
		if (visited.has(id)) {
			historyWarning = {
				code: "history_cycle",
				message: "A repeated history reference was skipped.",
			};
			continue;
		}
		visited.add(id);
		let ancestor: BrainMemory | null;
		try {
			ancestor = await getBrainMemoryById({
				userId: input.userId,
				memoryId: id,
			});
		} catch {
			historyWarning = {
				code: "history_unavailable",
				message: "Some memory history could not be read.",
			};
			continue;
		}
		if (!ancestor) {
			historyWarning = {
				code: "history_unavailable",
				message: "Some memory history could not be read.",
			};
			continue;
		}
		if (
			ancestor.userId !== memory.userId ||
			ancestor.ownerType !== memory.ownerType ||
			ancestor.ownerId !== memory.ownerId ||
			JSON.stringify(ancestor.scope) !== JSON.stringify(memory.scope)
		) {
			historyWarning = {
				code: "history_identity_mismatch",
				message:
					"A history reference outside this memory's ownership was omitted.",
			};
			continue;
		}
		const revision = ancestor.metadata?.revision as
			| Record<string, unknown>
			| undefined;
		const retirement = ancestor.metadata?.revisionRetired as
			| Record<string, unknown>
			| undefined;
		const reason = retirement?.reason ?? revision?.reason;
		history.push({
			id: ancestor.id,
			subject: ancestor.subject,
			content: ancestor.content,
			status: ancestor.status,
			evidenceRefs: ancestor.evidenceRefs,
			createdAt: ancestor.createdAt,
			updatedAt: ancestor.updatedAt,
			reason: typeof reason === "string" ? reason : null,
			revisionVersion: getBrainMemoryRevisionVersion(ancestor),
		});
		pending.push(...(ancestor.supersedes ?? []));
	}
	return {
		memory: versioned(memory),
		expectedVersion: getBrainMemoryRevisionVersion(memory),
		history,
		historyLimit: 8,
		historyTruncated: pending.length > 0,
		...(historyWarning ? { historyWarning } : {}),
	};
}

async function findReceipt(
	store: DrizzleDB,
	userId: string,
	reviewId: string,
	requestHash: string,
) {
	const [review] = await store
		.select()
		.from(brainMemoryReviews)
		.where(
			and(
				eq(brainMemoryReviews.id, reviewId),
				eq(brainMemoryReviews.userId, userId),
			),
		);
	if (!review) return null;
	const metadata = review.metadata as Record<string, unknown>;
	if (
		metadata.source !== REVISION_SOURCE ||
		metadata.requestHash !== requestHash
	) {
		throw new BrainMemoryRevisionError(
			"command_conflict",
			409,
			"commandId was already used for a different revision",
		);
	}
	return { ...(metadata.receipt as BrainMemoryRevisionResult), replayed: true };
}

/** Owner-command only. It changes the interpretation layer, never business ledgers or grants. */
export async function reviseBrainMemory(input: {
	requester: BrainRequester;
	memoryId: string;
	request: unknown;
	now?: Date;
}): Promise<BrainMemoryRevisionResult> {
  const remote=remoteOwnerOperation(input.requester,'legacy.revise',input);if(remote)return remote;
	if (input.requester.type !== "chat")
		throw new BrainMemoryRevisionError(
			"owner_revision_required",
			403,
			"An explicit owner revision is required",
		);
	if (!UUID.test(input.memoryId)) invalid("Invalid memory ID");
	const request = parseBrainMemoryRevisionRequest(input.request);
	const userId = input.requester.userId;
	const reviewId = commandRecordId(userId, request.commandId, "review");
	const requestHash = createHash("sha256")
		.update(
			JSON.stringify({ memoryId: input.memoryId.toLowerCase(), ...request }),
		)
		.digest("hex");
	const now = input.now ?? new Date();
	if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
		invalid("Invalid submission time");
	if (
		request.sourceObservedAt &&
		new Date(request.sourceObservedAt).getTime() > now.getTime() + 5 * 60_000
	) {
		invalid(
			"sourceObservedAt cannot be later than the submission time plus five minutes",
		);
	}
	return withBrainMemoryTransaction(userId, async (store) => {
		// The UUID PK is the durable uniqueness guard; the lock also serializes commands targeting different rows.
		await acquireBrainWriteAdvisoryLock(
			store,
			JSON.stringify([REVISION_SOURCE, userId, request.commandId]),
		);
		const replay = await findReceipt(store, userId, reviewId, requestHash);
		if (replay)
			return {
				memory: replay.newMemory ?? replay.oldMemory,
				result: replay,
				written: false,
			};

		const where = and(
			eq(brainMemories.id, input.memoryId),
			eq(brainMemories.userId, userId),
		);
		const [snapshotRow] = await store.select().from(brainMemories).where(where);
		if (!snapshotRow)
			throw new BrainMemoryRevisionError(
				"memory_not_found",
				404,
				"Brain memory not found",
			);
		const canonicalLockKey = getBrainMemoryCanonicalWriteLockKey(
			brainMemoryFromRow(snapshotRow),
		);
		// Ordinary admission uses the same group-before-row lock order.
		await acquireBrainWriteAdvisoryLock(store, canonicalLockKey);
		const [row] = await store
			.select()
			.from(brainMemories)
			.where(where)
			.for("update", brainWriteRowLockOptions());
		if (!row)
			throw new BrainMemoryRevisionError(
				"memory_not_found",
				404,
				"Brain memory not found",
			);
		const existing = brainMemoryFromRow(row);
		if (
			(existing.metadata?.updateProposal as Record<string, unknown> | undefined)
				?.status === "pending"
		) {
			throw new BrainMemoryRevisionError(
				"memory_update_decision_required",
				409,
				"Accept or reject the pending update through its versioned decision before revising it",
			);
		}
		const previousVersion = getBrainMemoryRevisionVersion(existing);
		const retirement = existing.metadata?.revisionRetired as
			| Record<string, unknown>
			| undefined;
		const issue = revisionTransitionIssue({
			expectedVersion: request.expectedVersion,
			currentVersion: previousVersion,
			sameIdentity:
				getBrainMemoryCanonicalWriteLockKey(existing) === canonicalLockKey,
			pendingProposal: false,
			restoring: request.operation === "restore",
			restorable:
				existing.status === "deleted" && retirement?.nextMemoryId === null,
			retired:
				existing.status === "superseded" || existing.status === "deleted",
		});
		if (issue === "version_conflict")
			throw new BrainMemoryRevisionError(
				"version_conflict",
				409,
				"Memory changed; read the current version before submitting again",
				previousVersion,
			);
		if (issue)
			throw new BrainMemoryRevisionError(
				"memory_inactive",
				409,
				"Only a deactivated current memory can be restored as a new version; otherwise revise its current replacement",
				previousVersion,
			);

		const observationId = commandRecordId(
			userId,
			request.commandId,
			"observation",
		);
		const newMemoryId =
			request.operation === "deactivate"
				? null
				: commandRecordId(userId, request.commandId, "replacement");
		const assertionRef = `brain-observation:${observationId}`;
		const previousRevision = existing.metadata?.revision as
			| Record<string, unknown>
			| undefined;
		const previousAssertions = new Set(
			Array.isArray(previousRevision?.assertionEvidenceRefs)
				? previousRevision.assertionEvidenceRefs.filter(
						(ref): ref is string => typeof ref === "string",
					)
				: [],
		);
		const replacementSources = [
			...new Set(
				[...existing.evidenceRefs, ...request.evidenceRefs].filter(
					(ref) => !previousAssertions.has(ref),
				),
			),
		];
		if (newMemoryId && replacementSources.length > 100)
			invalid(
				"The replacement would exceed 100 source references; reduce supplementary references before submitting",
			);
		const replacementEvidenceRefs = [
			...new Set([...replacementSources, assertionRef]),
		];
		const submission = JSON.parse(JSON.stringify(input.request)) as Record<
			string,
			unknown
		>;
		const submissionText = JSON.stringify({
			memoryId: existing.id,
			request: submission,
		});
		await store
			.insert(brainObservations)
			.values(
				brainObservationToInsertRow({
					id: observationId,
					userId,
					sourceType: "owner_memory_revision",
					sourceId: request.commandId,
					observedAt: now,
					content: submissionText,
					contentHash: createHash("sha256")
						.update(submissionText)
						.digest("hex"),
					trustLevel: "owner_assertion",
					metadata: {
						source: REVISION_SOURCE,
						reviewId,
						memoryId: existing.id,
						request: submission,
						submittedAt: now.toISOString(),
						sourceObservedAt: request.sourceObservedAt ?? null,
						provesOwnerSubmissionOnly: true,
						independentlyVerifiesBusinessFact: false,
					},
				}),
			)
			.returning();

		const createdAt = now.toISOString();
		const verificationRequired =
			request.operation !== "deactivate" &&
			(request.authority !== "owner_statement" ||
				!OWNER_ACTIVE_TYPES.has(existing.memoryType));
		let replacement: BrainMemory | null = null;
		if (newMemoryId) {
			const canonical = getBrainMemoryCanonicalMetadata(existing);
			const oldObservationTime =
				existing.metadata?.observationTime ?? existing.createdAt;
			const status = verificationRequired ? "candidate" : "active";
			const baseMetadata = { ...existing.metadata };
			delete baseMetadata.revisionRetired;
			delete baseMetadata.updateProposal;
			const newMemory: BrainMemory = {
				...existing,
				id: newMemoryId,
				content: request.content!,
				status,
				evidenceRefs: replacementEvidenceRefs,
				supersedes: [existing.id],
				createdAt,
				updatedAt: createdAt,
				metadata: {
					...baseMetadata,
					...canonical,
					observationTime:
						request.operation === "state_change" && request.sourceObservedAt
							? new Date(request.sourceObservedAt).toISOString()
							: oldObservationTime,
					observationTimeUnknown:
						request.operation === "state_change"
							? !request.sourceObservedAt
							: existing.metadata?.observationTimeUnknown === true,
					revision: {
						operation: request.operation,
						commandId: request.commandId,
						previousMemoryId: existing.id,
						previousVersion,
						authority: request.authority,
						reviewStatus: verificationRequired
							? "pending_verification"
							: "applied",
						rootMemoryId: previousRevision?.rootMemoryId ?? existing.id,
						sequence:
							typeof previousRevision?.sequence === "number"
								? previousRevision.sequence + 1
								: 1,
						createdAt,
						sourceObservedAt: request.sourceObservedAt ?? null,
						observationId,
						reason: request.reason,
						assertionEvidenceRefs: [assertionRef],
						independentlyVerifiesBusinessFact: false,
					},
				},
			};
			// Explicit revisions bypass canonical admission ranking. Ownership is copied only from the locked row.
			const [newRow] = await store
				.insert(brainMemories)
				.values(brainMemoryToInsertRow(newMemory))
				.returning();
			replacement = brainMemoryFromRow(newRow);
		}
		const [retiredRow] = await store
			.update(brainMemories)
			.set({
				status: request.operation === "deactivate" ? "deleted" : "superseded",
				updatedAt: now,
				metadata: {
					...existing.metadata,
					revisionRetired: {
						operation: request.operation,
						commandId: request.commandId,
						reviewId,
						nextMemoryId: newMemoryId,
						previousVersion,
						createdAt,
						reason: request.reason,
					},
				},
			})
			.where(where)
			.returning();
		const retired = brainMemoryFromRow(retiredRow);
		const oldMemory = versioned(retired);
		const newMemory = replacement ? versioned(replacement) : null;
		const result: BrainMemoryRevisionResult = {
			commandId: request.commandId,
			replayed: false,
			operation: request.operation,
			oldMemory,
			newMemory,
			receipt: {
				id: reviewId,
				commandId: request.commandId,
				status: verificationRequired ? "pending_verification" : "applied",
				effective:
					request.operation === "deactivate" ||
					(!!newMemory &&
						newMemory.status === "active" &&
						(!newMemory.expiresAt ||
							new Date(newMemory.expiresAt).getTime() > now.getTime())),
				previousVersion,
				currentVersion: oldMemory.revisionVersion,
				newVersion: newMemory?.revisionVersion ?? null,
				oldMemoryId: existing.id,
				newMemoryId,
				verificationRequired,
				createdAt,
			},
		};
		const review = brainMemoryReviewToInsertRow({
			userId,
			memoryId: existing.id,
			reviewerType: input.requester.type,
			reviewerId: input.requester.id ?? userId,
			decision: "edited",
			reason: request.reason,
			evidenceRefs: replacement?.evidenceRefs ?? [
				...new Set([
					...existing.evidenceRefs,
					...request.evidenceRefs,
					assertionRef,
				]),
			],
			metadata: {
				source: REVISION_SOURCE,
				commandId: request.commandId,
				requestHash,
				request: submission,
				operation: request.operation,
				authority: request.authority,
				observationId,
				previousVersion,
				currentVersion: oldMemory.revisionVersion,
				newVersion: newMemory?.revisionVersion ?? null,
				previousStatus: existing.status,
				nextStatus: retired.status,
				newMemoryId,
				beforeMemory: existing,
				afterMemory: retired,
				replacementMemory: replacement,
				independentlyVerifiesBusinessFact: false,
				receipt: result,
			},
		});
		await store
			.insert(brainMemoryReviews)
			.values({ ...review, id: reviewId, createdAt: now })
			.returning();
		await recordMemoryChangeInTransaction(store, {
			beforeMemory: existing,
			afterMemory: retired,
			replacementMemory: replacement,
			commandId: request.commandId,
			reason: request.reason,
			now,
			reviewId,
		});
		return { memory: replacement ?? retired, result, written: true };
	});
}
