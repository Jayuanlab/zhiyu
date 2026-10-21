/** Compatibility only; actual implementations live in Memory capabilities. */
export { BRAIN_RETIREMENT_SIGNAL_WINDOW_MS, BRAIN_RETIREMENT_SIGNAL_LIMIT, BrainRetirementSignalError, readBrainRetirementSignals } from "@/lib/memory/context/retirement-signals";
export { queryBrainRetirementIdentities } from "@/lib/memory/adapters/postgres/retirement-signals";
export type { BrainRetirementIdentity, BrainRetirementQuery } from "@/lib/memory/records/retirement-signals";
export type { BrainRetirementSignal } from "@/lib/memory/context/retirement-signals";
