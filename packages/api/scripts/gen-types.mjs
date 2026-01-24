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
  // --export-referenced-types: Ensure all used types are exported
  execSync(
    `npx dts-bundle-generator -o "${OUTPUT_FILE}" --project tsconfig.json --no-check "${ENTRY_FILE}"`,
    {
      stdio: "inherit",
      cwd: ROOT_DIR,
    }
  );

  // Post-process: specific fixes
  let content = readFileSync(OUTPUT_FILE, "utf-8");

  // Fix 1: SuperJSON transformer type
  // tRPC v11 with superjson often results in 'transformer: false' or complex types that break consumers
  // We relax it to 'any' or 'SuperJSON' reference if possible, but 'any' is safest for the contract
  content = content.replace(/transformer:\s*false;/, "transformer: any;");

  // Fix 2: Remove weird 'typeof self' that leaks from Yjs if present
  // content = content.replace(/typeof self/g, "any"); 
  
  writeFileSync(OUTPUT_FILE, content);

  console.log(`✅ Types generated at ${OUTPUT_FILE}`);
} catch (error) {
  console.error("❌ Type generation failed:", error);
  process.exit(1);
}
