import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function inventoryWriteRoutes(directory = path.join(web, "app")) {
  const entries = [];
  for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) entries.push(...inventoryWriteRoutes(file));
    else if (item.name === "route.ts") {
      const source = fs.readFileSync(file, "utf8");
      const methods = ["POST", "PUT", "PATCH", "DELETE"].filter(method => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b`, "s").test(source));
      if (methods.length) entries.push({file: path.relative(web, file).replaceAll("\\", "/"), methods, sessionCheckInFile: /await auth\(/.test(source), boundary: "proxy identity-v1; resource authorization requires separate review"});
    }
  }
  return entries.sort((a,b) => a.file.localeCompare(b.file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = inventoryWriteRoutes();
  fs.writeFileSync(path.join(web, "../../docs/plans/2026-09-06-review-remediation/records/05-write-routes.json"), JSON.stringify({generatedAt: new Date().toISOString(), entries}, null, 2));
  console.log(JSON.stringify({routes: entries.length, withoutInlineSessionCheck: entries.filter(entry => !entry.sessionCheckInFile).length}));
}
