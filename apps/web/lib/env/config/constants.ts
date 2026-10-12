/**
 * Application Constants
 *
 * Centralized configuration constants for openzhiyu.
 * All hardcoded values should be defined here for easy management.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

// ============================================================================
// Application Identity
// ============================================================================

/** Application name */
export const APP_NAME = "Zhiyu";

/** Application data directory name (used in home directory) */
export const APP_DIR_NAME = ".openzhiyu";

/** Claude Code directory name (system config) */
export const CLAUDE_DIR_NAME = ".claude";

// ============================================================================
// Server Configuration
// ============================================================================

/** Default API server port */
export const DEFAULT_API_PORT = 2620;

/** Default API server host */
export const DEFAULT_API_HOST = "localhost";

// ============================================================================
// Directory Structure
// ============================================================================

/** Default work directory path (relative to home) */
export const DEFAULT_WORK_DIR = `~/${APP_DIR_NAME}`;

/** Sessions subdirectory name */
export const SESSIONS_DIR_NAME = "sessions";

/** Skills subdirectory name */
export const SKILLS_DIR_NAME = "skills";

/** Logs subdirectory name */
export const LOGS_DIR_NAME = "logs";

/** Cache subdirectory name */
export const CACHE_DIR_NAME = "cache";

// ============================================================================
// Configuration Files
// ============================================================================

/** Main config filename */
export const CONFIG_FILE_NAME = "config.json";

/** MCP config filename */
export const MCP_CONFIG_FILE_NAME = "mcp.json";

/** Config file search paths (relative) */
export const CONFIG_SEARCH_PATHS = [
  "./openzhiyu.config.json",
  "./config/openzhiyu.json",
];

// ============================================================================
// Default Provider Settings
// ============================================================================

/** Default sandbox provider type */
export const DEFAULT_SANDBOX_PROVIDER = "codex";

/** Default agent provider type */
export const DEFAULT_AGENT_PROVIDER = "claude";

/** Default agent model */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-20250514";

// ============================================================================
// Timeouts and Limits
// ============================================================================

/** Default script execution timeout (ms) */
export const DEFAULT_SCRIPT_TIMEOUT = 120000;

/** Default job execution timeout (ms) - Jobs running longer than this are considered stuck */
export const DEFAULT_JOB_TIMEOUT_MS = 1200 * 60 * 1000;

/** Default API request timeout (ms) */
export const DEFAULT_API_TIMEOUT = 30000;

/** Maximum sandbox pool size */
export const DEFAULT_SANDBOX_POOL_SIZE = 5;

// ============================================================================
// Network Configuration
// ============================================================================

/** Sandbox API port (internal) */
export const SANDBOX_API_PORT = 2620;

/** Get sandbox API URL */
export function getSandboxApiUrl(): string {
  return (
    process.env.SANDBOX_API_URL ||
    `http://${DEFAULT_API_HOST}:${SANDBOX_API_PORT}`
  );
}

// ============================================================================
// Path Helpers (cross-platform compatible)
// ============================================================================

/** Get user home directory */
export function getHomeDir(): string {
  return homedir();
}

function joinRuntimePath(...segments: string[]): string {
  // Keep user-controlled path segments opaque to Next.js output tracing. A
  // direct join(homedir(), dynamicSegment) is widened into a home-wide glob.
  return Reflect.apply(join, undefined, segments);
}

/** Expand a user-provided ~/ path at runtime without exposing a broad build-time glob. */
export function expandHomePath(value: string): string {
  const appAlias = `~/${APP_DIR_NAME}`;
  const normalized = value.replace(/\\/g, "/");
  if (
    process.env.ZHIYU_APP_DATA_DIR?.trim() &&
    (normalized === appAlias || normalized.startsWith(`${appAlias}/`))
  ) {
    const appDir = getAppDir();
    const expanded = joinRuntimePath(appDir, normalized.slice(appAlias.length + 1));
    const suffix = relative(appDir, expanded);
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error("app_data_path_must_stay_inside");
    }
    return expanded;
  }
  if (value === "~") return getHomeDir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return joinRuntimePath(getHomeDir(), value.slice(2));
  }
  return value;
}

/** Get Zhiyu app data directory */
export function getAppDir(): string {
  const configured = process.env.ZHIYU_APP_DATA_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("app_data_directory_must_be_absolute");
    return configured;
  }
  return join(homedir(), APP_DIR_NAME);
}

/** Get Claude Code directory */
export function getClaudeDir(): string {
  return join(homedir(), CLAUDE_DIR_NAME);
}

/** Get Zhiyu skills directory */
export function getopenzhiyuSkillsDir(): string {
  return join(getAppDir(), SKILLS_DIR_NAME);
}

/** Get Claude skills directory */
export function getClaudeSkillsDir(): string {
  return join(getClaudeDir(), SKILLS_DIR_NAME);
}

/** Get all skills directories to search */
export function getAllSkillsDirs(): { name: string; path: string }[] {
  return [
    { name: "Zhiyu", path: getopenzhiyuSkillsDir() },
    { name: "claude", path: getClaudeSkillsDir() },
  ];
}

/** Get Zhiyu MCP config path */
export function getopenzhiyuMcpConfigPath(): string {
  return join(getAppDir(), MCP_CONFIG_FILE_NAME);
}

/** Get Claude settings path (contains MCP config) */
export function getClaudeSettingsPath(): string {
  return join(getClaudeDir(), "settings.json");
}

/** Get all MCP config paths to search */
export function getAllMcpConfigPaths(): { name: string; path: string }[] {
  return [
    { name: "Zhiyu", path: getopenzhiyuMcpConfigPath() },
    { name: "claude", path: getClaudeSettingsPath() },
  ];
}
