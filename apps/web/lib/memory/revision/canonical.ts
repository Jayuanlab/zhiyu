// Compatibility capability entry. Shared canonical identity rules live in the kernel.
export {
  normalizeBrainScenarioKeys, brainScenarioKeysFromHints, buildInteractionScenarioApplicabilityFacets,
  getBrainMemoryScenarioApplicability, matchBrainMemoryScenarioApplicability,
  inferBrainCanonicalKind, buildCanonicalGroupId, buildBrainMemoryMetadata, getBrainMemoryCanonicalMetadata,
} from "../kernel/memory-canonical";
export type {
  BrainCanonicalKind, BrainMemoryFacetValue, BrainMemoryFacets, BrainScenarioApplicability,
  BrainDerivedMemoryRef, BrainMemoryCanonicalMetadata, BrainMemoryMetadata, BrainCanonicalInput,
} from "../kernel/memory-canonical";
