import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => fixture.home,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

import { expandHomePath } from "@/lib/env/config/constants";
import { getAllSkillsDirs, loadSkills } from "@/lib/ai/skills/loader";
import { GET as listWorkspaceSkills } from "@/app/api/workspace/skills/route";

const previousAppDir = process.env.ZHIYU_APP_DATA_DIR;
const previousProjectSkills = process.env.OPENZHIYU_PROJECT_SKILLS_DIR;
let root: string;
let appDir: string;
let packagedSkills: string;
let implicitSkills: string;

function writeSkill(base: string, name: string, description: string) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zhiyu-private-pi-"));
  fixture.home = join(root, "old-home");
  appDir = join(root, "installed", "app-data");
  packagedSkills = join(root, "payload", "skills");
  const cwd = join(root, "implicit-project", "apps", "web");
  implicitSkills = join(cwd, "skills");
  mkdirSync(cwd, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.ZHIYU_APP_DATA_DIR = appDir;
  process.env.OPENZHIYU_PROJECT_SKILLS_DIR = packagedSkills;
  writeSkill(join(appDir, "skills"), "private-method", "private-content");
  writeSkill(packagedSkills, "packaged-method", "packaged-content");
  writeSkill(join(fixture.home, ".openzhiyu", "skills"), "old-zhiyu", "old-zhiyu-content");
  writeSkill(join(fixture.home, ".claude", "skills"), "old-claude", "old-claude-content");
  writeSkill(join(fixture.home, ".agents", "skills"), "old-agents", "old-agents-content");
  writeSkill(implicitSkills, "implicit-method", "implicit-content");
  vi.mocked(readFileSync).mockClear();
  vi.mocked(readdirSync).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousAppDir === undefined) delete process.env.ZHIYU_APP_DATA_DIR;
  else process.env.ZHIYU_APP_DATA_DIR = previousAppDir;
  if (previousProjectSkills === undefined) delete process.env.OPENZHIYU_PROJECT_SKILLS_DIR;
  else process.env.OPENZHIYU_PROJECT_SKILLS_DIR = previousProjectSkills;
  if (!basename(root).startsWith("zhiyu-private-pi-") || join(tmpdir(), basename(root)) !== root) {
    throw new Error("fixture_cleanup_path_invalid");
  }
  rmSync(root, { recursive: true, force: true });
});

describe("installed Pi filesystem isolation", () => {
  it("reads chat workspace files from the private application directory", () => {
    const suffix = join("sessions", "chat-1", "note.txt");
    for (const [base, content] of [[appDir, "private-note"], [join(fixture.home, ".openzhiyu"), "old-note"]]) {
      mkdirSync(join(base, "sessions", "chat-1"), { recursive: true });
      writeFileSync(join(base, suffix), content, "utf8");
    }
    expect(readFileSync(expandHomePath("~/.openzhiyu/sessions/chat-1/note.txt"), "utf8")).toBe("private-note");
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path))).toEqual([join(appDir, suffix)]);
    expect(expandHomePath("~/.openzhiyu")).toBe(appDir);
    expect(expandHomePath("~\\.openzhiyu\\sessions\\chat-1")).toBe(join(appDir, "sessions", "chat-1"));
  });

  it("preserves regular home paths and rejects traversal out of the private alias", () => {
    expect(expandHomePath("~")).toBe(fixture.home);
    expect(expandHomePath("~/Documents")).toBe(join(fixture.home, "Documents"));
    expect(expandHomePath("~/.openzhiyu-other/file.txt")).toBe(join(fixture.home, ".openzhiyu-other", "file.txt"));
    expect(() => expandHomePath("~/.openzhiyu/../outside.txt")).toThrow("app_data_path_must_stay_inside");
  });

  it("loads only private and explicitly packaged skills without reading old home files", () => {
    const skills = loadSkills();
    expect(skills.map(skill => skill.name).sort()).toEqual(["packaged-method", "private-method"]);
    expect(vi.mocked(readdirSync).mock.calls.map(([path]) => String(path))).toEqual([join(appDir, "skills"), packagedSkills]);
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path)).sort()).toEqual([
      join(appDir, "skills", "private-method", "SKILL.md"),
      join(packagedSkills, "packaged-method", "SKILL.md"),
    ].sort());
  });

  it("does not fall back to implicit project or home skills when packaged skills are unset", () => {
    delete process.env.OPENZHIYU_PROJECT_SKILLS_DIR;
    expect(getAllSkillsDirs()).toEqual([join(appDir, "skills")]);
    expect(loadSkills().map(skill => skill.name)).toEqual(["private-method"]);
  });

  it("lists private and packaged skills without reading global skills in the management API", async () => {
    const response = await listWorkspaceSkills();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skills.map((skill: { id: string }) => skill.id).sort()).toEqual(["packaged-method", "private-method"]);
    expect(body.directories).toEqual({ openzhiyu: join(appDir, "skills"), project: packagedSkills });
    expect(vi.mocked(readdirSync).mock.calls.map(([path]) => String(path))).toEqual([join(appDir, "skills"), packagedSkills]);
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path)).sort()).toEqual([
      join(appDir, "skills", "private-method", "SKILL.md"),
      join(packagedSkills, "packaged-method", "SKILL.md"),
    ].sort());
  });

  it("preserves the development management API's original home skill directories", async () => {
    delete process.env.ZHIYU_APP_DATA_DIR;
    const body = await (await listWorkspaceSkills()).json();
    expect(body.skills.map((skill: { id: string }) => skill.id).sort()).toEqual(["old-agents", "old-claude", "old-zhiyu"]);
    expect(body.directories).toEqual({
      openzhiyu: join(fixture.home, ".openzhiyu", "skills"),
      claude: join(fixture.home, ".claude", "skills"),
      agents: join(fixture.home, ".agents", "skills"),
    });
  });

  it("retains the normal development home and project skill behavior", () => {
    delete process.env.ZHIYU_APP_DATA_DIR;
    delete process.env.OPENZHIYU_PROJECT_SKILLS_DIR;
    expect(expandHomePath("~/.openzhiyu/sessions/chat-1")).toBe(join(fixture.home, ".openzhiyu", "sessions", "chat-1"));
    expect(loadSkills().map(skill => skill.name).sort()).toEqual(["implicit-method", "old-agents", "old-claude", "old-zhiyu"]);
  });
});
