/**
 * Check for orphaned REST route files — .ts files in hub-protocol/rest/ that
 * don't have a matching register*Routes export in rest/index.ts.
 *
 * Usage: node packages/api/src/routers/hub-protocol/rest/check-orphan-routes.mjs
 * Exit code 0 = clean, 1 = orphans found.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REST_DIR = __dirname; // runs from rest/
const INDEX_FILE = join(REST_DIR, "index.ts");

if (!existsSync(INDEX_FILE)) {
  console.error("ERROR: index.ts not found at", INDEX_FILE);
  process.exit(1);
}

// ---- Collect route files (exclude infrastructure) ----
const routeFiles = new Set();
for (const f of readdirSync(REST_DIR)) {
  if (
    f.endsWith(".ts") &&
    !f.startsWith("_") &&
    f !== "index.ts" &&
    f !== "auth.test.ts" &&
    f !== "automation-schema-doc.ts"
  ) {
    routeFiles.add(f.replace(/\.ts$/, ""));
  }
}

// ---- Collect register exports from index.ts ----
const indexContent = readFileSync(INDEX_FILE, "utf-8");
const exportRegex = /export\s*\{\s*((?:register\w+Routes\s*,?\s*)+)\}/g;
const registerExports = new Set();

let exportMatch;
while ((exportMatch = exportRegex.exec(indexContent)) !== null) {
  const names = exportMatch[1].split(",").map((s) => s.trim());
  for (const name of names) {
    if (name.startsWith("register") && name.endsWith("Routes")) {
      registerExports.add(name);
    }
  }
}

// ---- Build a Set of every `export function register*Routes` in the directory ----
const definedFunctions = new Set();
for (const f of readdirSync(REST_DIR)) {
  if (!f.endsWith(".ts") || f === "index.ts") continue;
  const content = readFileSync(join(REST_DIR, f), "utf-8");
  const fnRegex = /export (?:function |const )((?:register)\w+Routes)/g;
  let fnMatch;
  while ((fnMatch = fnRegex.exec(content)) !== null) {
    definedFunctions.add(fnMatch[1]);
  }
}

// ---- Cross-reference: files → any function definition? ----
const orphans = [];
for (const file of routeFiles) {
  const content = readFileSync(join(REST_DIR, `${file}.ts`), "utf-8");
  const fnRegex = /export (?:function |const )((?:register)\w+Routes)/g;
  let hasExport = false;
  let fnMatch;
  while ((fnMatch = fnRegex.exec(content)) !== null) {
    if (registerExports.has(fnMatch[1])) {
      hasExport = true;
    }
  }
  if (!hasExport) {
    orphans.push({ file, content: content.slice(0, 200) });
  }
}

// ---- Cross-reference: register export → defined somewhere? ----
const extraExports = [];
for (const reg of registerExports) {
  if (!definedFunctions.has(reg)) {
    extraExports.push(reg);
  }
}

// ---- Report ----
let exitCode = 0;

if (orphans.length > 0) {
  exitCode = 1;
  console.error(
    `✗ Found ${orphans.length} route file(s) without a register export in index.ts:\n`
  );
  for (const { file } of orphans) {
    console.error(`  ${file}.ts — no register*Routes export imported in index.ts`);
  }
  console.error();
}

if (extraExports.length > 0) {
  exitCode = 1;
  console.error(
    `✗ Found ${extraExports.length} register export(s) with no matching function definition:\n`
  );
  for (const reg of extraExports) {
    console.error(`  ${reg} — no 'export function ${reg}' found in any route file`);
  }
  console.error();
}

if (exitCode === 0) {
  console.log(
    `✓ All ${routeFiles.size} route files match ${registerExports.size} register exports`
  );
}
process.exit(exitCode);
