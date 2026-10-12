/**
 * Shared Logger Utility
 *
 * Provides file-based logging for debugging in distributed apps.
 * All logs are written to ~/.openzhiyu/logs/openzhiyu.log
 *
 * Console output is only enabled in development environment
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAppDir } from "../env/config/constants";

const LOG_DIR = join(getAppDir(), "logs");
const LOG_FILE = join(LOG_DIR, "openzhiyu.log");
const isDevelopment =
  process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

function ensureLogDir() {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch {
    // Ignore errors
  }
}

function logToFile(
  level: string,
  prefix: string,
  message: string,
  data?: unknown,
) {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${level}] [${prefix}] ${message}`;
    if (data !== undefined) {
      logLine += ` ${serializeLogData(data)}`;
    }
    logLine += "\n";
    appendFileSync(LOG_FILE, logLine);
  } catch {
    // Ignore logging errors
  }
}

function serializeLogData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Error) {
    return JSON.stringify(
      {
        name: data.name,
        message: data.message,
        stack: data.stack,
      },
      null,
      2,
    );
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * Create a logger instance with a specific prefix
 * @param prefix - Prefix for log messages (e.g., 'AgentService', 'ClaudeAgent')
 */
export function createLogger(prefix: string) {
  return {
    info: (message: string, data?: unknown) => {
      if (isDevelopment) {
        console.log(`[${prefix}] ${message}`, data ?? "");
      }
      logToFile("INFO", prefix, message, data);
    },
    error: (message: string, data?: unknown) => {
      if (isDevelopment) {
        console.error(`[${prefix}] ${message}`, data ?? "");
      }
      logToFile("ERROR", prefix, message, data);
    },
    warn: (message: string, data?: unknown) => {
      if (isDevelopment) {
        console.warn(`[${prefix}] ${message}`, data ?? "");
      }
      logToFile("WARN", prefix, message, data);
    },
    debug: (message: string, data?: unknown) => {
      // Debug only logs to file, not console (in all environments)
      logToFile("DEBUG", prefix, message, data);
    },
  };
}

/** Log file path for user reference */
export const LOG_FILE_PATH = LOG_FILE;

// Pre-defined logger instances for common modules
export const workspaceLogger = createLogger("Workspace");
export const dingTalkLogger = createLogger("DingTalk");
export const weixinLogger = createLogger("Weixin");
export const apiLogger = createLogger("API");
