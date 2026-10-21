import {
	budgetContextPack as budget,
	negotiateContextPack as negotiate,
} from "../../../../../packages/memory/src/context";
import type { ContextEntry, MemoryContextPack } from "../query-contracts";
export function budgetContextPack(
	input: MemoryContextPack,
	reservedBytes = 0,
): MemoryContextPack | null {
	return budget<ContextEntry, MemoryContextPack>(input, reservedBytes);
}
export function negotiateContextPack(
	input: MemoryContextPack,
	options: { ceilingBytes: number; reservedBytes?: number },
) {
	return negotiate<ContextEntry, MemoryContextPack>(input, options);
}
