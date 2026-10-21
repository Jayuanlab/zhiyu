import { budgetContextPack as budget } from "../../../../../packages/memory/src/context";
import type { ContextEntry, MemoryContextPack } from "../query-contracts";
export function budgetContextPack(input: MemoryContextPack, reservedBytes = 0): MemoryContextPack | null { return budget<ContextEntry,MemoryContextPack>(input,reservedBytes); }
