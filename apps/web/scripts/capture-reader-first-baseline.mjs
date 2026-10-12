import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve("../..");
const directory = path.join(root, "docs/verification/artifacts/research-reader-first-2026-10-09");
const files = ["lib/workshops/research-final-validation.ts", "lib/workshops/run-prompt.ts",
  "tests/unit/workshop-research-final-validation.test.ts", "scripts/observe-deepseek-deployment.mts"];
mkdirSync(path.join(directory, "baseline"), { recursive: true });
const entries = files.map(file => {
  const bytes = readFileSync(file);
  const target = path.join(directory, "baseline", file.replaceAll("/", "__"));
  if (existsSync(target)) throw Error("baseline_already_exists");
  writeFileSync(target, bytes, { flag: "wx" });
  return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync(path.join(directory, "baseline-root.json"), JSON.stringify({ at: new Date().toISOString(), entries }, null, 2) + "\n", { flag: "wx", encoding: "utf8" });
console.log(JSON.stringify({ files: entries.length, directory }));
