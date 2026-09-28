import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const upstream = join(root, "third_party", "openai-cua-sample-app");
const patch = join(root, "patches", "cua", "zhiyu-workshop.patch");
const expected = "f2a3dc523ae406f9b704f9a420a05402a63b4522";

function git(args) {
  return execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

if (!existsSync(join(upstream, "README.md"))) {
  throw new Error("CUA submodule is missing; run git submodule update --init third_party/openai-cua-sample-app");
}
const commit = git(["rev-parse", "HEAD"]);
if (commit !== expected) throw new Error(`Unexpected CUA upstream commit ${commit}; expected ${expected}`);
if (!existsSync(patch)) throw new Error(`CUA integration patch is missing: ${patch}`);

try {
  git(["apply", "--ignore-space-change", "--reverse", "--check", patch]);
  process.stdout.write("CUA Work integration patch is already applied.\n");
} catch {
  git(["apply", "--ignore-space-change", "--check", patch]);
  git(["apply", "--ignore-space-change", patch]);
  process.stdout.write("CUA Work integration patch applied.\n");
}
