import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { copyFile, mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { WorkshopSource } from "@/lib/db/schema";
import {createCodebaseSearchTools,readCodebaseFile} from './codebase-read';

export const PI_LOCAL_TOOL_NAMES = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "PowerShell"] as const;
export type PiLocalToolName = (typeof PI_LOCAL_TOOL_NAMES)[number];

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_COMMAND_MS = 60_000;

function withinRoot(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel));
}

async function nearestExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await nearestExisting(parent), basename(path));
  }
}

export async function checkedRunPath(runDir: string, requestedPath: string, write = false) {
  const root = await realpath(runDir);
  const candidate = resolve(root, requestedPath);
  if (!withinRoot(root, candidate)) throw new Error("Path is outside this Work run directory");
  const canonical = await nearestExisting(candidate);
  if (!withinRoot(root, canonical) || canonical === root) {
    throw new Error("Path resolves outside this Work run directory");
  }
  if (write && canonical === join(root, "workspace-scope.json")) {
    throw new Error("Workspace ownership metadata is read-only to Pi file tools");
  }
  if (write && withinRoot(join(root, "inputs"), canonical)) {
    throw new Error("Input copies are read-only to Pi file tools");
  }
  return canonical;
}

function sourceLocalPath(source: WorkshopSource) {
  if (!source.uri || source.type !== "file" || !source.enabled) return null;
  if (source.uri.startsWith("file://")) {
    try {
      return fileURLToPath(source.uri);
    } catch {
      return null;
    }
  }
  return isAbsolute(source.uri) ? source.uri : null;
}

export async function stagePiWorkshopFileSources(runDir: string, sources: WorkshopSource[]) {
  const inputDir = join(runDir, "inputs");
  await mkdir(inputDir, { recursive: true });
  const staged: Array<{ sourceId: string; sourcePath: string; runPath: string; size: number; sha256: string; inputPath?: string; scope?: string }> = [];
  const warnings: Array<{ sourceId: string; reason: string; inputPath?: string; scope?: string }> = [];
  for (const source of sources) {
    if (source.type !== "file" || !source.enabled) continue;
    const scope = source.config && typeof source.config === "object" && source.config.scope === "conversation"
      ? { inputPath: source.uri ?? "", scope: "conversation" } : {};
    const path = sourceLocalPath(source);
    if (!path) {
      warnings.push({ sourceId: source.id, ...scope, reason: "File source has no supported local path" });
      continue;
    }
    try {
      const sourcePath = await realpath(path);
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
        warnings.push({ sourceId: source.id, ...scope, reason: "Source is not a file or exceeds 100 MiB" });
        continue;
      }
      const safeName = basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, "_");
      const runPath = join(inputDir, `${source.id}-${safeName}`);
      await copyFile(sourcePath, runPath);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(runPath)) hash.update(chunk);
      const sha256 = hash.digest("hex");
      const configuredHash = source.config && typeof source.config === "object"
        ? (source.config as Record<string, unknown>).sha256
        : undefined;
      if (typeof configuredHash === "string" && configuredHash !== sha256) {
        await unlink(runPath);
        warnings.push({ sourceId: source.id, ...scope, reason: "Source content changed since it was added; verify and upload it again" });
        continue;
      }
      staged.push({ sourceId: source.id, sourcePath, runPath, size: info.size, sha256, ...scope });
    } catch (error) {
      warnings.push({ sourceId: source.id, ...scope, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  await writeFile(join(inputDir, "index.json"), JSON.stringify({ staged, warnings }, null, 2), "utf8");
  return { staged, warnings };
}

export function createPiLocalTools(runDir: string, codebaseRoot?: string): AgentTool<any>[] {
  const powershellPath = process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : null;
  const powershellOperations = powershellPath && existsSync(powershellPath)
    ? { exec: async (command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
        const env: NodeJS.ProcessEnv = {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.Path ?? process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PATHEXT: process.env.PATHEXT,
        };
        const child = spawn(powershellPath, [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
        ], { cwd, env, windowsHide: true, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", options.onData);
        child.stderr.on("data", options.onData);
        const timer = setTimeout(() => child.kill(), Math.min(options.timeout ?? MAX_COMMAND_MS, MAX_COMMAND_MS));
        try {
          return await new Promise<{ exitCode: number | null }>((resolveResult, reject) => {
            child.once("error", reject);
            child.once("close", exitCode => resolveResult({ exitCode }));
          });
        } finally {
          clearTimeout(timer);
        }
      } }
    : undefined;
  const builtins: Array<[PiLocalToolName, AgentTool<any>]> = [
    ["Read", createReadTool(runDir)],
    ["Edit", createEditTool(runDir)],
    ["Write", createWriteTool(runDir)],
    ["Bash", createBashTool(runDir, { exposeSessionEnvironment: false })],
    ...(process.platform === "win32"
      ? [["PowerShell", createPowerShellTool(runDir, { exposeSessionEnvironment: false, operations: powershellOperations })] as [PiLocalToolName, AgentTool<any>]]
      : []),
  ];
  const tools: AgentTool<any>[] = builtins.map(([name, tool]) => ({
    ...tool,
    name,
    label: name,
    replay: "never" as const,
    executionMode: "sequential" as const,
    execute: async (id: string, rawParams: any, signal?: AbortSignal, onUpdate?: any) => {
      signal?.throwIfAborted();
      const params = { ...rawParams };
      if(name==='Read' && typeof params.path==='string' && /^repo[\\/]/.test(params.path)){
        if(!codebaseRoot)throw Error('Codebase reading is not granted to this Work');
        return readCodebaseFile(codebaseRoot,params,signal);
      }
      if (name === "Read" || name === "Edit" || name === "Write") {
        if (typeof params.path !== "string" || !params.path.trim()) throw new Error("A file path is required");
        params.path = await checkedRunPath(runDir, params.path, name !== "Read");
      } else {
        if (typeof params.command !== "string" || !params.command.trim()) throw new Error("A command is required");
        params.timeout = Math.min(MAX_COMMAND_MS, Math.max(1, Number(params.timeout) || MAX_COMMAND_MS));
      }
      signal?.throwIfAborted();
      const result = await tool.execute(id, params, signal, onUpdate);
      if (name !== "Write" && name !== "Edit") return result;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(params.path)) hash.update(chunk);
      return { ...result, details: { ...(result.details ?? {}), artifactPath: params.path, sha256: hash.digest("hex") } };
    },
  }));
  return [...tools,...(codebaseRoot?createCodebaseSearchTools(codebaseRoot):[])];
}
