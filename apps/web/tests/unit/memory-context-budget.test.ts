import { describe, expect, it } from "vitest";
import {
	budgetContextPack,
	negotiateContextPack,
} from "@/lib/memory/context/budget";
import type {
	ContextEntry,
	MemoryContextPack,
} from "@/lib/memory/query-contracts";

const receiptId = "00000000-0000-4000-8000-000000000001";
function entry(
	content: string,
	id = "00000000-0000-4000-8000-000000000002",
): ContextEntry {
	return {
		ref: {
			record: { kind: "memory", id },
			revision: `bmrv1:${"a".repeat(64)}`,
		},
		subject: "Source",
		content,
		useSemantics: "saved_interpretation",
		evidenceRefs: ["brain-observation:00000000-0000-4000-8000-000000000003"],
		freshness: {
			asOf: "2026-10-20T00:00:00.000Z",
			observedAt: "2026-10-19T00:00:00.000Z",
			basis: "observation",
		},
		receipt: { id: receiptId, kind: "context_admission" },
	};
}
function pack(maxTokens: number): MemoryContextPack {
	return {
		interfaceVersion: "memory-context.v1",
		contextLogId: receiptId,
		constraints: [],
		currentStates: [],
		historicalEvidence: [],
		interpretations: [],
		openQuestions: [],
		budget: {
			maxTokens,
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
}
const bytes = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), "utf8");

describe("public Memory context budget", () => {
	it("keeps a sufficient preferred window and rejects already truncated constraints", () => {
		const input = pack(8192);
		input.constraints = [
			{ ...entry("完整原文"), useSemantics: "safety_constraint" },
		];
		expect(
			negotiateContextPack(input, { ceilingBytes: 65536 }).pack?.budget
				.maxTokens,
		).toBe(8192);
		input.constraints[0].truncated = true;
		expect(budgetContextPack(input)).toBeNull();
		expect(() => negotiateContextPack(input, { ceilingBytes: 65536 })).toThrow(
			"incomplete_safety_constraint",
		);
	});

	it("negotiates an explicit bounded window without dropping or rewriting any required constraint", () => {
		const input = pack(8192);
		input.constraints = Array.from({ length: 16 }, (_, index) => ({
			...entry("完整约束🧠".repeat(60), `constraint-${index}`),
			useSemantics: "safety_constraint" as const,
		}));
		input.interpretations = [entry("Applicable lesson.")];
		input.historicalEvidence = [entry("Historical source ".repeat(10000))];
		const original = structuredClone(input);
		expect(budgetContextPack(input)).toBeNull();
		const result = negotiateContextPack(input, {
			ceilingBytes: 65536,
			reservedBytes: 1024,
		});
		expect(result.pack).not.toBeNull();
		expect(result.pack!.constraints).toEqual(input.constraints);
		expect(result.pack!.interpretations).toEqual(input.interpretations);
		expect(result.pack!.budget.maxTokens).toBeGreaterThan(8192);
		expect(result.pack!.budget.maxTokens).toBeLessThanOrEqual(65536);
		expect(bytes(result.pack) + 1024).toBeLessThanOrEqual(
			result.pack!.budget.maxTokens,
		);
		expect(input).toEqual(original);
	});

	it("refuses an adaptive ceiling that cannot contain the full constraints", () => {
		const input = pack(8192);
		input.constraints = [
			{
				...entry("不可省略的约束".repeat(6000)),
				useSemantics: "safety_constraint",
			},
		];
		const result = negotiateContextPack(input, { ceilingBytes: 16384 });
		expect(result.pack).toBeNull();
		expect(result.requiredBytes).toBeGreaterThan(16384);
	});
	it.each([1024, 2048, 8192])(
		"bounds serialized UTF-8 bytes at %s while keeping a valid source prefix",
		(maxTokens) => {
			const input = pack(maxTokens);
			const original = entry('中🧠"\\\n'.repeat(3000));
			input.interpretations = [original];
			const output = budgetContextPack(input)!;
			expect(output).not.toBeNull();
			expect(output.budget.usedUpperBound).toBeLessThanOrEqual(maxTokens);
			expect(output.budget.usedUpperBound).toBeGreaterThanOrEqual(
				bytes(output),
			);
			expect(output.budget.truncated).toBe(true);
			// At the smallest public budget even the mandatory ref/receipt envelope may
			// not fit; omitting an ordinary fact is allowed and must remain observable.
			expect(output.interpretations).toHaveLength(maxTokens === 1024 ? 0 : 1);
			if (!output.interpretations.length) return;
			const clipped = output.interpretations[0];
			expect(original.content.startsWith(clipped.content)).toBe(true);
			expect(clipped.content.length).toBeLessThan(original.content.length);
			expect(clipped.content.isWellFormed()).toBe(true);
			expect(clipped).toMatchObject({
				ref: original.ref,
				receipt: original.receipt,
				evidenceRefs: original.evidenceRefs,
				freshness: original.freshness,
				truncated: true,
				truncationReason: "context_budget",
			});
		},
	);

	it("keeps every safety constraint complete before spending the remainder on facts", () => {
		const input = pack(2300);
		const boundary = {
			...entry("Never send an external message without the owner's approval."),
			useSemantics: "safety_constraint" as const,
		};
		input.constraints = [boundary];
		input.interpretations = [
			entry(
				"interpreted fact ".repeat(1000),
				"00000000-0000-4000-8000-000000000004",
			),
		];
		const output = budgetContextPack(input)!;
		expect(output.constraints).toEqual([boundary]);
		expect(output.interpretations[0].truncated).toBe(true);
		expect(bytes(output)).toBeLessThanOrEqual(input.budget.maxTokens);
	});

	it("refuses a pack when complete required boundaries cannot fit", () => {
		const input = pack(1024);
		input.constraints = [
			{
				...entry("不可忽略的完整边界🧠".repeat(300)),
				useSemantics: "safety_constraint",
			},
		];
		expect(budgetContextPack(input)).toBeNull();
		expect(input.constraints[0].truncated).toBeUndefined();
	});

	it("retains observation receipt pointers and exact immutable versions when clipping evidence", () => {
		const input = pack(1400),
			source = entry("evidence🧠".repeat(1000));
		source.ref = {
			record: {
				kind: "observation",
				id: "00000000-0000-4000-8000-000000000003",
			},
			revision: `obsrv1:${"b".repeat(64)}`,
		};
		source.useSemantics = "raw_observation";
		source.receipt = { id: receiptId, kind: "observation_evidence_read" };
		input.historicalEvidence = [source];
		const output = budgetContextPack(input)!;
		expect(output.historicalEvidence[0]).toMatchObject({
			ref: source.ref,
			receipt: source.receipt,
			evidenceRefs: source.evidenceRefs,
		});
		expect(
			Array.from(source.content)
				.slice(0, Array.from(output.historicalEvidence[0].content).length)
				.join(""),
		).toBe(output.historicalEvidence[0].content);
	});

	it("does not mutate the input pack, refs or receipts", () => {
		const input = pack(1200);
		input.interpretations = [entry("🧠".repeat(2000))];
		const baseline = structuredClone(input);
		budgetContextPack(input);
		expect(input).toEqual(baseline);
	});

	it("marks omitted questions and question prefixes as truncated without splitting Unicode", () => {
		const input = pack(8192);
		input.openQuestions = Array.from({ length: 10 }, (_, index) => ({
			code: `gap-${index}`,
			detail: "a".repeat(119) + "🧠tail",
		}));
		const output = budgetContextPack(input)!;
		expect(output.openQuestions).toHaveLength(8);
		expect(output.budget.truncated).toBe(true);
		expect(output.openQuestions[0].detail.isWellFormed()).toBe(true);
		expect(Array.from(output.openQuestions[0].detail)).toHaveLength(120);
		expect(
			input.openQuestions[0].detail.startsWith(output.openQuestions[0].detail),
		).toBe(true);
	});
});
