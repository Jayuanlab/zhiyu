import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { hasMemoryModelScope } from '@/lib/memory/context/model-source-scope';
import { unregisteredFileSource } from '@/lib/memory/evidence/unregistered-file';
import { describeWorkFileSource, readWorkFile } from '@/lib/memory/files/read';
import { Type } from '@earendil-works/pi-ai';

export const PI_LOCAL_TOOL_NAMES = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "PowerShell"] as const;
export type PiLocalToolName = (typeof PI_LOCAL_TOOL_NAMES)[number];

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

export async function stagePiWorkshopFileSources(runDir: string, sources: WorkshopSource[]) {
  const inputDir = join(runDir, "inputs");
  await mkdir(inputDir, { recursive: true });
  const staged: Array<{ sourceId: string; sourcePath: string; runPath: string; size: number; sha256: string; inputPath?: string; scope?: string }> = [];
  const warnings: Array<{ sourceId: string; reason: string; inputPath?: string; scope?: string }> = [];
  for (const source of sources) {
    if (source.type !== "file" || !source.enabled) continue;
    try {
      const file = await describeWorkFileSource(source.id);
      staged.push({ sourceId: source.id, sourcePath: `artifact:${file.artifactId}`, runPath: file.runPath, size: file.size, sha256: file.sha256,
        inputPath: file.runPath, scope: file.semantics });
    } catch {
      warnings.push({ sourceId: source.id, reason: "memory_source_scope_unverified: No current authorized Work file binding; reimport and bind a managed snapshot" });
    }
  }
  await writeFile(join(inputDir, "index.json"), JSON.stringify({ staged, warnings }, null, 2), "utf8");
  return { staged, warnings, representation: 'virtual_bound_source_catalog' as const };
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
    ...(name === 'Read' ? { parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), expectedRevision: Type.Optional(Type.String()) }),
      description: 'Read a bounded UTF-16 text window from a current formally bound managed file using inputs/<sourceId>/<name> or source:<sourceId>. Paths and staged index files do not grant host filesystem access. Binary documents require workshopConvertDocument. Separately granted repo/ paths retain their codebase contract.' } : {}),
    ...(['Bash', 'PowerShell'].includes(name) ? { description: 'Unavailable in a Memory model run: cwd and environment filtering do not isolate private host files. Use an approved domain action or import a managed artifact.' } : {}),
    ...(name==='Read'&&codebaseRoot?{description:'Read bounded text only from a formally bound managed source:<sourceId> or inputs/<sourceId>/<name>. No arbitrary host paths. For separately granted repo/ reads, cite only the returned citation range and SHA256; totalLines is the file extent, not observed coverage. Use nextRead verbatim to continue.'}:{}),
    replay: "never" as const,
    executionMode: "sequential" as const,
    execute: async (id: string, rawParams: any, signal?: AbortSignal, onUpdate?: any) => {
      signal?.throwIfAborted();
      if ((name === 'Bash' || name === 'PowerShell') && hasMemoryModelScope()) {
        const gap = unregisteredFileSource('unisolated_shell');
        return { content: [{ type: 'text', text: JSON.stringify(gap) }], details: gap, isError: true };
      }
      const params = { ...rawParams };
      if(name==='Read' && typeof params.path==='string' && /^repo[\\/]/.test(params.path)){
        if(!codebaseRoot)throw Error('Codebase reading is not granted to this Work');
        return readCodebaseFile(codebaseRoot,params,signal);
      }
      if (name === 'Read' && typeof params.path === 'string') {
        const match = params.path.match(/^(?:source:|inputs[\\/])([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:[\\/][^\\/]+)?$/i);
        if (match) {
          const result = await readWorkFile({ sourceId: match[1], offset: params.offset, expectedRevision: params.expectedRevision });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        }
      }
      if (name === "Read" || name === "Edit") {
        const gap = unregisteredFileSource("unregistered-work-run-file");
        return { content: [{ type: "text", text: JSON.stringify(gap) }], details: gap, isError: true };
      }
      if (name === "Write") {
        if (typeof params.path !== "string" || !params.path.trim()) throw new Error("A file path is required");
        params.path = await checkedRunPath(runDir, params.path, true);
      } else {
        if (typeof params.command !== "string" || !params.command.trim()) throw new Error("A command is required");
        params.timeout = Math.min(MAX_COMMAND_MS, Math.max(1, Number(params.timeout) || MAX_COMMAND_MS));
      }
      signal?.throwIfAborted();
      const result = await tool.execute(id, params, signal, onUpdate);
      if (name !== "Write") return result;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(params.path)) hash.update(chunk);
      return { ...result, details: { ...(result.details ?? {}), artifactPath: params.path, sha256: hash.digest("hex") } };
    },
  }));
  return [...tools.filter(tool => !hasMemoryModelScope() || !['Bash', 'PowerShell'].includes(tool.name)),...(codebaseRoot?createCodebaseSearchTools(codebaseRoot):[])];
}
