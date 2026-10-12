import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const previous = JSON.parse(readFileSync("../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/targeted-regression-review57-final.json", "utf8"));
const tests = new Set(previous.testResults.map(result => {
  const name = result.name.replaceAll("\\", "/").split("/tests/unit/")[1];
  assert.match(name, /^[a-z0-9-]+\.test\.ts$/);
  return "tests/unit/" + name;
}));
for (const test of ["workshop-research-reader-brief", "research-claim-conditions", "workshop-work-presentation",
  "workshop-research-report-display", "workshop-runtime-directive-planner", "workshop-research-reader-delivery",
  "workshop-research-reader-validation"]) tests.add("tests/unit/" + test + ".test.ts");
console.log(JSON.stringify({ uniqueTestFiles: tests.size, previousTestFiles: previous.testResults.length }));
const outputName = process.argv[2] ?? "targeted-regression-final.json";
assert.match(outputName, /^[a-z0-9-]+\.json$/);
const artifactFolder = outputName.startsWith("reader-first-") ? "research-reader-first-2026-10-09" : "research-report-quality-2026-10-09";
const result = spawnSync(process.execPath, ["../../node_modules/vitest/vitest.mjs", "run", ...tests,
  "--reporter=json", "--outputFile=../../docs/verification/artifacts/" + artifactFolder + "/" + outputName],
  { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
