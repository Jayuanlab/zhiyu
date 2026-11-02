/**
 * Skills Loader
 *
 * Load skill definitions from ~/.openzhiyu/skills/ directory
 * Shared read-only skill discovery for Pi. Legacy directories are import sources only.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expandHomePath,
  getAppDir,
  getClaudeDir,
  getHomeDir,
} from "@/lib/env/config/constants";

export interface SkillMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  argumentHint?: string;
  path: string;
}

/**
 * Get default skills directory path
 */
export function getDefaultSkillsDir(): string {
  return join(getAppDir(), "skills");
}

/**
 * Get all skills source directories to sync from
 */
export function getAllSkillsDirs(): string[] {
  const configuredProjectDir = process.env.OPENZHIYU_PROJECT_SKILLS_DIR?.trim();
  if (process.env.ZHIYU_APP_DATA_DIR?.trim()) {
    return Array.from(new Set([
      join(getAppDir(), "skills"),
      ...(configuredProjectDir ? [configuredProjectDir] : []),
    ]));
  }
  const projectDirs = [
    configuredProjectDir,
    join(process.cwd(), "skills"),
    join(process.cwd(), "..", "..", "skills"),
  ].filter((value): value is string => Boolean(value));

  return Array.from(
    new Set([
      join(getAppDir(), "skills"),
      join(getClaudeDir(), "skills"),
      join(getHomeDir(), ".agents", "skills"),
      ...projectDirs,
    ]),
  );
}

/**
 * Parse frontmatter from SKILL.md file
 */
function parseSkillMetadata(content: string, skillPath: string): SkillMetadata {
  const frontmatterRegex = /^---\n([\s\S]+?)\n---/;
  const match = content.match(frontmatterRegex);

  const metadata: SkillMetadata = {
    name: "Unknown",
    description: "No description",
    path: skillPath,
  };

  if (match) {
    const frontmatter = match[1];
    const field = (name: string) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = frontmatter.match(
        new RegExp(`^${escaped}:\\s*(?:["']([^"']+)["']|([^\\n#]+))`, "m"),
      );
      return (match?.[1] ?? match?.[2] ?? "").trim();
    };

    metadata.name = field("name") || metadata.name;
    metadata.description = field("description") || metadata.description;
    metadata.version = field("version") || metadata.version;
    metadata.author = field("author") || metadata.author;
    metadata.license = field("license") || metadata.license;
    metadata.argumentHint = field("argument_hint") || metadata.argumentHint;
  }

  return metadata;
}

/**
 * Load all available skills from all source directories.
 * Deduplicates by name, prioritizing in order: .openzhiyu > .agent > .claude
 */
export function loadSkills(): SkillMetadata[] {
  const skills: SkillMetadata[] = [];
  const skillsByName = new Map<string, SkillMetadata>();

  for (const dir of getAllSkillsDirs()) {
    if (!existsSync(dir)) continue;

    try {
      const skillFolders = readdirSync(dir, { withFileTypes: true });

      for (const folder of skillFolders) {
        if (!folder.isDirectory() || skillsByName.has(folder.name)) continue;

        const skillPath = join(dir, folder.name);
        const skillMdPath = join(skillPath, "SKILL.md");

        if (existsSync(skillMdPath)) {
          try {
            const content = readFileSync(skillMdPath, "utf-8");
            const metadata = parseSkillMetadata(content, skillPath);
            skillsByName.set(folder.name, metadata);
          } catch (error) {
            console.error(
              `[SkillsLoader] Failed to read skill ${folder.name}:`,
              error,
            );
          }
        }
      }
    } catch (error) {
      console.error(`[SkillsLoader] Failed to load skills from ${dir}:`, error);
    }
  }

  for (const skill of skillsByName.values()) {
    skills.push(skill);
  }

  console.log(`[SkillsLoader] Loaded ${skills.length} skills from all source directories`);
  return skills;
}

/**
 * Get SKILL.md content for a skill
 */
export function getSkillContent(skillPath: string): string | null {
  const skillMdPath = join(skillPath, "SKILL.md");

  if (!existsSync(skillMdPath)) {
    return null;
  }

  try {
    return readFileSync(skillMdPath, "utf-8");
  } catch (error) {
    console.error("[SkillsLoader] Failed to read skill content:", error);
    return null;
  }
}
