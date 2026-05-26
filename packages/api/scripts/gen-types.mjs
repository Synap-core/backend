import { execSync } from "child_process";
import { resolve, join } from "path";
import { writeFileSync, readFileSync } from "fs";

const ROOT_DIR = resolve(".");
const API_TYPES_DIR = resolve("../api-types");
const OUTPUT_FILE = join(API_TYPES_DIR, "src/generated.d.ts");
const ENTRY_FILE = join(ROOT_DIR, "src/root.ts");

console.log("🛠  Generating API types...");

try {
  // Generate types
  // --no-check: Skip type checking for speed (we assume build passed)
  // --project: Use api's tsconfig
  // NODE_OPTIONS: 4 GB heap to avoid SIGSEGV in memory-constrained environments (Docker)
  execSync(
    `npx dts-bundle-generator -o "${OUTPUT_FILE}" --project tsconfig.gen-types.json --no-check "${ENTRY_FILE}"`,
    {
      stdio: "inherit",
      cwd: ROOT_DIR,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
    }
  );

  // Post-process: specific fixes
  let content = readFileSync(OUTPUT_FILE, "utf-8");

  // Fix 1: SuperJSON transformer type
  content = content.replace(/transformer:\s*false;/, "transformer: any;");

  writeFileSync(OUTPUT_FILE, content);

  console.log(`✅ Types generated at ${OUTPUT_FILE}`);
} catch (error) {
  // dts-bundle-generator can SIGSEGV in memory-constrained Docker builds.
  // This is non-fatal: the previously-committed generated.d.ts stays in place.
  // Consumers continue to work; types will be refreshed on the next local run.
  const reason = error.signal ? `signal ${error.signal}` : String(error.message ?? error);
  console.warn(`⚠️  Type generation skipped (${reason}). Using existing generated.d.ts.`);
  process.exit(0);
}
