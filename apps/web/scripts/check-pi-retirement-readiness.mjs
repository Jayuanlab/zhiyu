import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["apps", "packages", "tools", "package.json", "pnpm-lock.yaml"];

const SKIP_SEGMENTS = new Set([
  ".git",
  ".next",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const PATTERNS = [
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-code",
  "claude-code",
  "CLAUDE_CODE_PATH",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "NATIVE_AGENT_DEFAULT_PROVIDER=claude",
  "provider: \"claude\"",
  "provider: 'claude'",
  "engine: \"claude\"",
  "engine: 'claude'",
];

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

function shouldSkip(path) {
  return path.split(/[\\/]/).some((segment) => SKIP_SEGMENTS.has(segment));
}

function isTextCandidate(path) {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

function walk(path, files) {
  if (shouldSkip(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), files);
    }
    return;
  }
  if (stat.isFile() && isTextCandidate(path)) files.push(path);
}

function classify(path, match) {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.endsWith("/scripts/check-pi-retirement-readiness.mjs")) {
    return "inventory_script_metadata";
  }
  if (normalized.includes("/tests/")) return "test_fixture";
  if (normalized.includes("/lib/ai/extensions/agent/claude/")) {
    return "compatible_claude_fallback";
  }
  if (
    normalized.includes("/lib/ai/mcp/tools/") ||
    normalized.endsWith("/lib/workshops/mcp-tools.ts")
  ) {
    return "compatible_claude_mcp_wrapper";
  }
  if (
    normalized === "apps/web/package.json" ||
    normalized === "pnpm-lock.yaml"
  ) {
    return "compatible_dependency_until_fallback_retired";
  }
  if (
    normalized === "apps/web/app/api/native/agent/route.ts" ||
    normalized === "apps/web/app/(chat)/api/preferences/ai/route.ts" ||
    normalized === "apps/web/app/(chat)/workshop/workshop-client.tsx" ||
    normalized === "apps/web/lib/work-evolution/report-quality-evaluator.ts"
  ) {
    return "runtime_compatibility_boundary";
  }
  if (
    normalized.endsWith("/lib/ai/model-policy.ts") ||
    normalized.includes("/lib/ai/runtime/") ||
    normalized.includes("/lib/workshops/") ||
    normalized.includes("/lib/loops/")
  ) {
    return "runtime_compatibility_boundary";
  }
  if (normalized.includes("/tools/ai-release-video-agent/")) {
    return "needs_review_standalone_tool";
  }
  if (match.includes("NATIVE_AGENT_DEFAULT_PROVIDER")) {
    return "operator_fallback_knob";
  }
  return "needs_review";
}

function main() {
  const files = [];
  for (const root of ROOTS) walk(root, files);

  const matches = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        if (!line.includes(pattern)) continue;
        const path = relative(process.cwd(), file).replaceAll("\\", "/");
        matches.push({
          category: classify(path, pattern),
          path,
          line: index + 1,
          match: pattern,
        });
      }
    });
  }

  const categories = {};
  for (const item of matches) {
    categories[item.category] ??= { count: 0, samples: [] };
    categories[item.category].count += 1;
    if (categories[item.category].samples.length < 20) {
      categories[item.category].samples.push(item);
    }
  }

  const result = {
    checkedRoots: ROOTS,
    patternCount: PATTERNS.length,
    matchCount: matches.length,
    categories,
    needsReviewCount: matches.filter((item) =>
      item.category.startsWith("needs_review"),
    ).length,
  };

  console.log(JSON.stringify(result, null, 2));

  if (
    process.argv.includes("--fail-on-needs-review") &&
    result.needsReviewCount > 0
  ) {
    process.exitCode = 1;
  }
}

main();
