import { lstat, mkdir, readFile, realpath, writeFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAppDir } from "@/lib/env/config/constants";

export type WorkspaceScope = {
  userId: string;
  workshopId?: string | null;
  loopId?: string | null;
  runId?: string;
};

export type WorkspaceLayout = {
  version: 1;
  userId: string;
  workshopId: string | null;
  loopId: string | null;
  workshopDir: string | null;
  loopDir: string | null;
  runDir: string | null;
  stateAuthority: "database";
  knowledgeAuthority: "authorized_sources_and_reviewed_memory";
  automaticPromotion: false;
  commandIsolation: "host_process";
};

function checkedId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) {
    throw new Error("Invalid workspace scope identifier");
  }
  return value;
}

export function workspaceLayout(scope: WorkspaceScope, appDir = getAppDir()): WorkspaceLayout {
  checkedId(scope.userId);
  const workshopId = scope.workshopId != null ? checkedId(scope.workshopId) : null;
  const loopId = scope.loopId != null ? checkedId(scope.loopId) : null;
  if (!workshopId && !loopId) throw new Error("A workshop or Loop scope is required");
  const root = resolve(appDir);
  const workshopDir = workshopId ? join(root, "workspaces", "workshops", workshopId) : null;
  const loopDir = loopId ? join(workshopDir ?? join(root, "workspaces"), "loops", loopId) : null;
  // Keep the existing artifact paths valid. Immutable per-run references below
  // the persistent spaces express ownership without moving or linking folders.
  const runDir = scope.runId !== undefined ? loopId
    ? join(root, "sessions", "loops", loopId, checkedId(scope.runId))
    : join(root, "sessions", "workshops", workshopId!, checkedId(scope.runId)) : null;
  return {
    version: 1, userId: scope.userId, workshopId, loopId, workshopDir, loopDir, runDir,
    stateAuthority: "database", knowledgeAuthority: "authorized_sources_and_reviewed_memory",
    automaticPromotion: false, commandIsolation: "host_process",
  };
}

function within(root: string, target: string) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Reject junctions/symlinks in managed paths before creating or reading files. */
async function managedDirectory(appDir: string, directory: string, create: boolean) {
  const root = resolve(appDir);
  if (!within(root, directory)) throw new Error("Workspace path is outside application data");
  if (create) await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  let cursor = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (create) await mkdir(cursor).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || !within(canonicalRoot, await realpath(cursor))) {
      throw new Error("Workspace directory resolves outside its managed boundary");
    }
  }
}

async function readManifest(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Invalid workspace manifest");
  return JSON.parse(await readFile(path, "utf8"));
}

/** Publish complete JSON atomically without overwriting an existing owner. */
async function ensureManifest(path: string, value: unknown) {
  const assertMatches = async () => {
    if (JSON.stringify(await readManifest(path)) !== JSON.stringify(value)) {
      throw new Error("Workspace ownership or manifest conflicts with the requested scope");
    }
  };
  try { await assertMatches(); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = join(dirname(path), `.workspace-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  try {
    await link(temp, path).catch(async error => {
      if (error.code !== "EEXIST") throw error;
      await assertMatches();
    });
  } finally { await unlink(temp); }
}

export async function prepareWorkspace(scope: WorkspaceScope, appDir = getAppDir()) {
  const layout = workspaceLayout(scope, appDir);
  const ensure = async (directory: string) => managedDirectory(appDir, directory, true);
  if (layout.workshopDir) {
    await ensure(layout.workshopDir);
    await ensureManifest(join(layout.workshopDir, "workspace.json"), {
      version: 1, kind: "workshop", userId: layout.userId, workshopId: layout.workshopId,
      stateAuthority: layout.stateAuthority, knowledgeAuthority: layout.knowledgeAuthority,
      automaticPromotion: false,
    });
    for (const child of ["artifacts", "run-references", "loops"]) await ensure(join(layout.workshopDir, child));
  }
  if (layout.loopDir) {
    await ensure(layout.loopDir);
    await ensureManifest(join(layout.loopDir, "workspace.json"), {
      version: 1, kind: "loop", userId: layout.userId, workshopId: layout.workshopId,
      loopId: layout.loopId, stateAuthority: layout.stateAuthority, automaticPromotion: false,
    });
    for (const child of ["artifacts", "run-references"]) await ensure(join(layout.loopDir, child));
  }
  if (layout.runDir) {
    await ensure(layout.runDir);
    await ensure(join(layout.runDir, "temp"));
    await ensureManifest(join(layout.runDir, "workspace-scope.json"), layout);
    const reference = { version: 1, userId: layout.userId, workshopId: layout.workshopId, loopId: layout.loopId, runId: scope.runId, runDir: layout.runDir };
    if (layout.workshopDir) await ensureManifest(join(layout.workshopDir, "run-references", `${layout.loopId ? `loop-${layout.loopId}-` : "workshop-"}${scope.runId}.json`), reference);
    if (layout.loopDir) await ensureManifest(join(layout.loopDir, "run-references", `${scope.runId}.json`), reference);
  }
  return layout;
}

export async function inspectWorkspace(scope: WorkspaceScope, appDir = getAppDir()) {
  const layout = workspaceLayout(scope, appDir);
  const directory = layout.loopDir ?? layout.workshopDir!;
  try {
    await managedDirectory(appDir, directory, false);
    for (const child of layout.loopDir ? ["artifacts", "run-references"] : ["artifacts", "run-references", "loops"]) {
      await managedDirectory(appDir, join(directory, child), false);
    }
    const manifest = await readManifest(join(directory, "workspace.json"));
    if (manifest.version !== 1 || manifest.userId !== layout.userId || manifest.workshopId !== layout.workshopId || manifest.stateAuthority !== "database" || manifest.automaticPromotion !== false ||
        (layout.loopId ? manifest.kind !== "loop" || manifest.loopId !== layout.loopId : manifest.kind !== "workshop")) {
      throw new Error("Workspace ownership conflicts with the requested scope");
    }
    return { ...layout, status: "ready" as const, warning: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...layout, status: "not_created" as const, warning: null };
    return { ...layout, status: "unavailable" as const, warning: error instanceof Error ? error.message : String(error) };
  }
}

export function workspacePrompt(layout: WorkspaceLayout) {
  return `Workspace ownership (host-managed; paths do not grant access):
${JSON.stringify(layout, null, 2)}
- The workshop is the persistent identity and the Loop is its persistent task scope. Each run has a separate working directory.
- Authoritative progress/checkpoints are in the database. Use permitted state tools; do not create a competing state file.
- Shared knowledge comes only from authorized sources and reviewed memory supplied by the host. Do not scan another run, Loop, or workshop.
- Write local outputs only inside the current run directory. Persistent artifacts require the owner's existing source/review workflow; never automatically promote outputs or edit workspace manifests.
- Local command tools run as host processes, not isolated containers. Directory ownership never expands the action policy or tool permissions.`;
}
