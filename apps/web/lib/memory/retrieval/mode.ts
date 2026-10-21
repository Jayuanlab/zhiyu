export type BrainMemoryMode = "brain_first" | "legacy_first" | "brain_only";

const MODES = new Set<BrainMemoryMode>([
  "brain_first",
  "legacy_first",
  "brain_only",
]);

export function getBrainMemoryMode(): BrainMemoryMode {
  const raw = process.env.BRAIN_MEMORY_MODE?.trim().toLowerCase();
  return MODES.has(raw as BrainMemoryMode)
    ? (raw as BrainMemoryMode)
    : "brain_first";
}

export function shouldReadLegacyMemoryFallback() {
  return getBrainMemoryMode() !== "brain_only";
}

export function shouldPreferBrainMemory() {
  return getBrainMemoryMode() !== "legacy_first";
}
