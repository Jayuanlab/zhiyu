import type { BrainRecallProfile } from "../context/pack";
import type { BrainMemoryType } from "../kernel/memory-types";

const MEMORY_TYPES = new Set<BrainMemoryType>([
  "fact",
  "preference",
  "plan",
  "boundary",
  "relationship",
  "task",
  "insight",
  "system",
]);

const MAX_PROFILES = 12;
const MAX_TERMS_PER_PROFILE = 64;
const MAX_TERM_LENGTH = 80;
const MAX_ABSOLUTE_BOOST = 200;

export type BrainRecallProfileIssueCode =
  | "invalid_collection"
  | "too_many_profiles"
  | "invalid_profile"
  | "invalid_id"
  | "duplicate_id"
  | "invalid_match_terms"
  | "too_many_match_terms"
  | "invalid_match_term"
  | "invalid_boosts"
  | "invalid_memory_type"
  | "invalid_boost";

export type BrainRecallProfileIssue = {
  code: BrainRecallProfileIssueCode;
  path: string;
  message: string;
};

export type ParsedBrainRecallProfiles = {
  profiles: BrainRecallProfile[];
  issues: BrainRecallProfileIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addIssue(
  issues: BrainRecallProfileIssue[],
  code: BrainRecallProfileIssueCode,
  path: string,
  message: string,
) {
  issues.push({ code, path, message });
}

export function parseBrainRecallProfiles(
  value: unknown,
): ParsedBrainRecallProfiles {
  if (value === undefined || value === null) {
    return { profiles: [], issues: [] };
  }

  if (!Array.isArray(value)) {
    return {
      profiles: [],
      issues: [
        {
          code: "invalid_collection",
          path: "memoryRecallProfiles",
          message: "memoryRecallProfiles must be an array.",
        },
      ],
    };
  }

  const profiles: BrainRecallProfile[] = [];
  const issues: BrainRecallProfileIssue[] = [];
  const ids = new Set<string>();

  if (value.length > MAX_PROFILES) {
    addIssue(
      issues,
      "too_many_profiles",
      "memoryRecallProfiles",
      `At most ${MAX_PROFILES} recall profiles may be bound to one Work.`,
    );
  }

  for (const [index, rawProfile] of value.slice(0, MAX_PROFILES).entries()) {
    const basePath = `memoryRecallProfiles[${index}]`;
    const profileIssuesStart = issues.length;
    if (!isRecord(rawProfile)) {
      addIssue(
        issues,
        "invalid_profile",
        basePath,
        "Recall profile must be an object.",
      );
      continue;
    }

    const id = typeof rawProfile.id === "string" ? rawProfile.id.trim() : "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      addIssue(
        issues,
        "invalid_id",
        `${basePath}.id`,
        "Profile id must use lowercase letters, digits, and hyphens.",
      );
    } else if (ids.has(id)) {
      addIssue(
        issues,
        "duplicate_id",
        `${basePath}.id`,
        `Duplicate recall profile id: ${id}`,
      );
    }

    const rawTerms = rawProfile.matchTerms;
    const matchTerms: string[] = [];
    if (!Array.isArray(rawTerms) || rawTerms.length === 0) {
      addIssue(
        issues,
        "invalid_match_terms",
        `${basePath}.matchTerms`,
        "matchTerms must be a non-empty array.",
      );
    } else {
      if (rawTerms.length > MAX_TERMS_PER_PROFILE) {
        addIssue(
          issues,
          "too_many_match_terms",
          `${basePath}.matchTerms`,
          `At most ${MAX_TERMS_PER_PROFILE} match terms are allowed per profile.`,
        );
      }
      for (const [termIndex, rawTerm] of rawTerms
        .slice(0, MAX_TERMS_PER_PROFILE)
        .entries()) {
        const term = typeof rawTerm === "string" ? rawTerm.trim() : "";
        if (term.length < 2 || term.length > MAX_TERM_LENGTH) {
          addIssue(
            issues,
            "invalid_match_term",
            `${basePath}.matchTerms[${termIndex}]`,
            `Match terms must contain 2-${MAX_TERM_LENGTH} characters.`,
          );
          continue;
        }
        if (!matchTerms.includes(term)) matchTerms.push(term);
      }
    }

    const rawBoosts = rawProfile.memoryTypeBoosts;
    const memoryTypeBoosts: BrainRecallProfile["memoryTypeBoosts"] = {};
    if (!isRecord(rawBoosts) || Object.keys(rawBoosts).length === 0) {
      addIssue(
        issues,
        "invalid_boosts",
        `${basePath}.memoryTypeBoosts`,
        "memoryTypeBoosts must be a non-empty object.",
      );
    } else {
      for (const [memoryType, rawBoost] of Object.entries(rawBoosts)) {
        if (!MEMORY_TYPES.has(memoryType as BrainMemoryType)) {
          addIssue(
            issues,
            "invalid_memory_type",
            `${basePath}.memoryTypeBoosts.${memoryType}`,
            `Unknown memory type: ${memoryType}`,
          );
          continue;
        }
        if (
          typeof rawBoost !== "number" ||
          !Number.isFinite(rawBoost) ||
          rawBoost === 0 ||
          Math.abs(rawBoost) > MAX_ABSOLUTE_BOOST
        ) {
          addIssue(
            issues,
            "invalid_boost",
            `${basePath}.memoryTypeBoosts.${memoryType}`,
            `Boost must be a non-zero number between -${MAX_ABSOLUTE_BOOST} and ${MAX_ABSOLUTE_BOOST}.`,
          );
          continue;
        }
        memoryTypeBoosts[memoryType as BrainMemoryType] = rawBoost;
      }
    }

    if (issues.length !== profileIssuesStart) continue;
    ids.add(id);
    profiles.push({ id, matchTerms, memoryTypeBoosts });
  }

  return { profiles, issues };
}

export function parseBrainRecallProfilesFromModelConfig(
  modelConfig: unknown,
): ParsedBrainRecallProfiles {
  const config = isRecord(modelConfig) ? modelConfig : {};
  return parseBrainRecallProfiles(config.memoryRecallProfiles);
}
