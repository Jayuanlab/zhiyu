import { spawn } from "node:child_process";
import { join } from "node:path";
import { aStockResourceDirectory, quantPythonArguments, quantPythonBinary, quantPythonEnvironment } from "@/lib/quant/install-paths";

export type AStockDataAction =
  | "quote"
  | "research"
  | "signals"
  | "trend"
  | "trend_system"
  | "etf_holdings"
  | "fundamentals"
  | "news_filings"
  | "market_mood";

export type AStockDataResult = {
  ok: boolean;
  action?: AStockDataAction;
  args?: Record<string, unknown>;
  data?: unknown;
  sources?: string[];
  warnings?: string[];
  dataQuality?: Record<string, unknown> | null;
  fetchedAt?: string;
  error?: string;
  errorType?: string;
  license?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_STDOUT_CHARS = 250_000;

function pythonBinary() {
  return quantPythonBinary(undefined, process.env, true);
}

function cliPath() {
  return join(aStockResourceDirectory(), "cli.py");
}

export async function runAStockDataAction(input: {
  action: AStockDataAction;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<AStockDataResult> {
  const payload = JSON.stringify({
    action: input.action,
    args: input.args ?? {},
  });

  let python: string, arguments_: string[], environment: NodeJS.ProcessEnv;
  try {
    python = pythonBinary();
    arguments_ = quantPythonArguments(cliPath(), process.env, true);
    environment = quantPythonEnvironment(process.env, true);
  } catch (error) {
    return { ok: false, action: input.action, error: error instanceof Error ? error.message : "astock_installation_configuration_invalid", errorType: "Configuration" };
  }

  return new Promise((resolve) => {
    const child = spawn(python, arguments_, {
      cwd: process.cwd(),
      env: {
        ...environment,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
        PYTHONUTF8: process.env.PYTHONUTF8 || "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        ok: false,
        action: input.action,
        error: `A-stock-data action timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
        errorType: "Timeout",
      });
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_CHARS) {
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        action: input.action,
        error: error.message,
        errorType: error.name,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const raw = (code === 0 ? stdout : stderr || stdout).trim();
      try {
        const parsed = JSON.parse(raw) as AStockDataResult;
        resolve(parsed);
      } catch {
        resolve({
          ok: false,
          action: input.action,
          error: raw || `A-stock-data process exited with code ${code}.`,
          errorType: "InvalidJson",
        });
      }
    });

    child.stdin?.end(payload);
  });
}
