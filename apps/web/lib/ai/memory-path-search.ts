import { promises as fs } from "node:fs";
import path from "node:path";
import { getAppDataDir, joinPath } from "@/lib/utils/path";

type FileEntry = {
  absolutePath: string;
  relativePath: string;
};

function splitKeywords(query: string) {
  return query.split(/[\s,，,、]+/).filter((keyword) => keyword.length > 0);
}

function normalizeMemoryDirectory(input: {
  memoryPath: string;
  directory?: string;
}) {
  const base = path.resolve(input.memoryPath);
  const target = path.resolve(base, input.directory ?? ".");
  const relative = path.relative(base, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Directory is outside the memory root.");
  }
  return { base, target };
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(input: {
  base: string;
  target: string;
  limit?: number;
}) {
  const limit = input.limit ?? 300;
  const files: FileEntry[] = [];
  async function visit(directory: string) {
    if (files.length >= limit) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) return;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.relative(input.base, absolutePath),
        });
      }
    }
  }
  await visit(input.target);
  return files;
}

async function listDirectory(target: string) {
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.slice(0, 30).map((entry) => {
    const type = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
    return `${type}\t${entry.name}`;
  });
}

async function readUtf8BestEffort(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function searchMemoryPathForUser(input: {
  query: string;
  searchInFiles?: boolean;
  directory?: string;
  memoryPath?: string;
}) {
  const query = input.query.trim();
  const searchInFiles = input.searchInFiles ?? true;
  const memoryPath = input.memoryPath ?? joinPath(getAppDataDir(), "data", "memory");
  const { base, target } = normalizeMemoryDirectory({
    memoryPath,
    directory: input.directory,
  });

  if (!(await pathExists(base))) {
    return {
      ok: true,
      text: `Memory directory does not exist at ${base}. You may need to create memory files first.`,
      data: {
        memoryPath: base,
        query,
        message: "Memory directory not found",
      },
    };
  }

  if (!(await pathExists(target))) {
    return {
      ok: true,
      text: `Directory does not exist: ${target}`,
      data: {
        memoryPath: base,
        targetDir: target,
        query,
        message: "Target directory not found",
      },
    };
  }

  const keywords = splitKeywords(query);
  const firstKeyword = keywords[0] || query;
  const results: string[] = [];
  const files = await collectFiles({ base, target });
  const lowerFirstKeyword = firstKeyword.toLowerCase();
  const matchingNameFiles = files.filter((file) =>
    file.relativePath.toLowerCase().includes(lowerFirstKeyword),
  );
  let fileCount = 0;
  let matchCount = 0;

  if (matchingNameFiles.length > 0) {
    fileCount = matchingNameFiles.length;
    results.push(
      `**Found ${fileCount} file(s) with names matching "${firstKeyword}":**`,
    );
    matchingNameFiles.slice(0, 20).forEach((file) => {
      results.push(`- ${file.relativePath}`);
    });
    if (fileCount > 20) {
      results.push(`... and ${fileCount - 20} more files`);
    }
  }

  if (searchInFiles && keywords.length > 0) {
    const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());
    const contentMatches: Array<{ file: FileEntry; lines: string[] }> = [];
    for (const file of files) {
      if (contentMatches.length >= 20) break;
      const content = await readUtf8BestEffort(file.absolutePath);
      if (!content) continue;
      const lines = content
        .split(/\r?\n/)
        .filter((line) =>
          lowerKeywords.some((keyword) => line.toLowerCase().includes(keyword)),
        );
      if (lines.length > 0) {
        contentMatches.push({ file, lines: lines.slice(0, 3) });
      }
    }

    if (contentMatches.length > 0) {
      matchCount = contentMatches.length;
      results.push(
        `\n**Found ${matchCount} file(s) with content matching keywords "${keywords.join(", ")}":**`,
      );
      contentMatches.forEach((match) => {
        results.push(`- ${match.file.relativePath}`);
      });
      results.push("\n**Sample content matches:**");
      contentMatches
        .flatMap((match) => match.lines)
        .slice(0, 15)
        .forEach((line) => {
          const trimmed = line.trim();
          const truncated =
            trimmed.length > 150 ? `${trimmed.slice(0, 150)}...` : trimmed;
          results.push(`  ${truncated}`);
        });
    }
  }

  const directoryLines = await listDirectory(target);
  if (directoryLines.length > 0) {
    results.push("\n**Directory structure:**");
    results.push("```");
    results.push(...directoryLines);
    results.push("```");
  }

  if (results.length === 0) {
    return {
      ok: true,
      text: `No matches found for "${query}" in memory directory (${target}).`,
      data: {
        memoryPath: base,
        targetDir: target,
        query,
        message: "No matches found",
      },
    };
  }

  return {
    ok: true,
    text: results.join("\n"),
    data: {
      memoryPath: base,
      targetDir: target,
      query,
      fileCount,
      matchCount,
      results: results.join("\n"),
    },
  };
}

