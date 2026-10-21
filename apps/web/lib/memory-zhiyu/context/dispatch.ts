import { createUseGuard } from "../../../../../packages/memory/src/use";
import { withDatabaseTransaction } from "@/lib/db/client";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import {
	finalizeContextPack,
	type FinalizeContextPackInput,
} from "@/lib/memory/context/finalize";
import type { BrainContextPackItem } from "@/lib/memory/context/pack";
import {
	admitExactUse,
	exactProofKey,
	exactProofVersions,
	revalidateExactUse,
	prepareExactUseRevalidation,
	type ExactUseProof,
} from "@/lib/memory/context/exact-use-admission";
import { withMemoryModelSourceScope } from "@/lib/memory/context/model-source-scope";

function unavailable() {
	return new MemoryModuleError(
		"memory_dispatch_context_unavailable",
		503,
		"Memory context changed or could not be verified before model dispatch; start a fresh context",
	);
}
function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, ordered(child)]),
		);
	return value;
}
function policy(input: FinalizeContextPackInput) {
	return structuredClone({
		requester: input.requester,
		accessMode: input.accessMode,
		sourceFilters: input.sourceFilters,
		includeCandidates: input.includeCandidates,
		applicabilityMode: input.applicabilityMode ?? input.pack.applicabilityMode,
		recallProfiles: input.recallProfiles,
	});
}
const guard = createUseGuard<FinalizeContextPackInput, ExactUseProof>({
	unavailable,
	scope: withMemoryModelSourceScope,
	contextKey: (input) => JSON.stringify(ordered(policy(input))),
	contextVersions: (input) =>
		input.pack.items.map((item) => ({
			identity: `${input.requester.userId}:${item.id}`,
			version: item.revisionVersion ?? "",
		})),
	proofKey: exactProofKey,
	proofVersions: exactProofVersions,
	merge(current, incoming) {
		const p = policy(incoming);
		const base = current ?? {
			...p,
			taskIntent: incoming.taskIntent,
			pack: {
				interfaceVersion: "brain-context.v1" as const,
				applicabilityMode: p.applicabilityMode,
				contextLogId: incoming.pack.contextLogId,
				items: [],
				denied: [],
				omitted: [],
				warnings: [],
				selection: {
					selectedCount: 0,
					deniedCount: 0,
					omittedCount: 0,
					duplicateCanonicalGroupCount: 0,
					selectedCanonicalKinds: {},
				},
			},
		};
		const items = new Map<string, BrainContextPackItem>(
			base.pack.items.map((item) => [item.id, item]),
		);
		let addedCount = 0;
		for (const original of incoming.pack.items) {
			if (items.has(original.id)) continue;
			addedCount++;
			items.set(original.id, {
				id: original.id,
				revisionVersion: original.revisionVersion,
				ownerType: original.ownerType,
				ownerId: original.ownerId,
				memoryType: original.memoryType,
				subject: original.subject,
				content: "",
				evidenceRefs: [],
				score: 0,
				reasons: ["dispatch_reference_only"],
			});
		}
		return {
			value: { ...base, pack: { ...base.pack, items: [...items.values()] } },
			addedCount,
		};
	},
	async admit(groups, proofs, sequence, assertCurrent) {
		const physical = new Map<
			ExactUseProof,
			Awaited<ReturnType<typeof prepareExactUseRevalidation>>
		>();
		for (const proof of proofs)
			physical.set(proof, await prepareExactUseRevalidation(proof));
		const receipts = await withDatabaseTransaction(async () => {
			const results: Array<{
				group: FinalizeContextPackInput;
				contextLogId: string;
			}> = [];
			for (const group of groups) {
				const items = group.pack.items;
				const pack = await finalizeContextPack({
					...group,
					now: undefined,
					metadata: {
						source: "memory_provider_dispatch_admission",
						dispatch: {
							schemaVersion: "memory-dispatch.v1",
							sequence,
							boundary: "logical_request_admission",
						},
					},
				});
				const actual = new Map(
					pack.items.map((item) => [item.id, item.revisionVersion]),
				);
				if (
					!pack.contextLogId ||
					actual.size !== items.length ||
					items.some((item) => actual.get(item.id) !== item.revisionVersion)
				)
					throw unavailable();
				results.push({ group, contextLogId: pack.contextLogId });
			}
			for (const proof of proofs)
				await revalidateExactUse(proof, sequence, physical.get(proof));
			assertCurrent();
			return results;
		});
		for (const receipt of receipts)
			receipt.group.pack.contextLogId = receipt.contextLogId;
	},
});
export const withMemoryDispatchContext = guard.run;
export function bindMemoryDispatchRuntime(runtime: {
	engine: string;
	adapter: string;
}) {
	guard.bind(
		(runtime.engine === "pi" &&
			(runtime.adapter === "pi-agent-harness" ||
				runtime.adapter === "pi-agent-core")) ||
			(runtime.engine === "claude" &&
				runtime.adapter === "claude-sdk-controlled-http"),
	);
}
export const exactUseRegistrationRequired = guard.registrationRequired;
export const isMemoryDispatchRuntimeSupported = guard.supported;
export const registerExactUseForDispatch = guard.registerProof;
export const registerContextForDispatch = guard.registerContext;
export const assertMemoryDispatchCurrent = guard.assertCurrent;
/** Plan capture remains a Zhiyu source adapter. */
export async function captureMemoryDispatchSources(
	userId: string,
): Promise<{ receiptIds: string[]; signature: string }> {
	const snapshot = guard.snapshot(),
		proofs = [...snapshot.proofs];
	for (const proof of proofs)
		if (
			proof.policy.requester.type !== "chat" ||
			proof.policy.requester.userId !== userId ||
			proof.refs.some(
				(ref) => ref.kind === "plan" || ref.kind === "file-binding",
			)
		)
			guard.invalidate();
	for (const group of snapshot.groups) {
		if (group.requester.type !== "chat" || group.requester.userId !== userId)
			guard.invalidate();
		proofs.push(
			await admitExactUse({
				requester: group.requester,
				accessMode: group.accessMode,
				sourceFilters: group.sourceFilters,
				purpose: "plan_captured_recall",
				memoryRefs: group.pack.items.map((item) => ({
					id: item.id,
					revision: item.revisionVersion!,
				})),
			}),
		);
	}
	if (proofs.length > 62 || snapshot.proofCount > 254) guard.invalidate();
	snapshot.assertCurrent();
	return {
		receiptIds: [...new Set(proofs.map((proof) => proof.receiptId))],
		signature: JSON.stringify(proofs.map(exactProofKey).sort()),
	};
}
