/**
 * verify-exports.mjs — post-build check that runtime functions survive tsup bundling.
 *
 * tsup's code-splitting can silently drop exports. The .d.ts files are correct
 * (from tsc), so TypeScript checks pass, but the actual JS exports may be missing
 * causing runtime crashes. This catches it at build time instead of at pod startup.
 */

const REQUIRED_RUNTIME_EXPORTS = [
  "SUBJECT_TYPES",
  "EVENT_ACTIONS",
  "EVENT_PHASES",
  "buildEventName",
  "subjectTrigger",
  "validateEventPattern",
  "parseEventPattern",
];

async function verify() {
  const mod = await import("../dist/index.js");
  const missing = [];

  for (const name of REQUIRED_RUNTIME_EXPORTS) {
    if (mod[name] === undefined) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.error(
      `Missing runtime exports from dist/index.js: ${missing.join(", ")}`
    );
    console.error(
      "This is likely a tsup code-splitting bug. Check tsup.config.ts."
    );
    process.exit(1);
  }

  // Also verify the events sub-path
  const events = await import("../dist/events/index.js");
  const missingEvents = [];
  for (const name of REQUIRED_RUNTIME_EXPORTS) {
    if (events[name] === undefined) {
      missingEvents.push(name);
    }
  }

  if (missingEvents.length > 0) {
    console.error(
      `Missing runtime exports from dist/events/index.js: ${missingEvents.join(", ")}`
    );
    process.exit(1);
  }

  // The grants sub-path (`@synap-core/types/grants`): the grammar the backend
  // enforces and the model every grant selector renders. A sub-path whose
  // dist lost a function would only fail at a consumer's runtime.
  const GRANTS_RUNTIME_EXPORTS = [
    "parsePermission",
    "permits",
    "resolveKeyExpiry",
    "GRANT_SUBJECT_CATALOG",
    "toggleGrant",
    "summarizeGrant",
    "GRANT_PRESETS",
  ];
  const grants = await import("../dist/grants/index.js");
  const missingGrants = GRANTS_RUNTIME_EXPORTS.filter(
    (name) => grants[name] === undefined
  );
  if (missingGrants.length > 0) {
    console.error(
      `Missing runtime exports from dist/grants/index.js: ${missingGrants.join(", ")}`
    );
    process.exit(1);
  }

  // Every `exports` SUB-PATH must point at a file that exists.
  //
  // The checks above prove named functions survive bundling in two barrels.
  // They cannot see a sub-path whose TARGET is wrong, and nothing else can
  // either: `browser/` derives its Vite aliases from this map and SKIPS a
  // target it cannot find (deliberately — an unbuilt dist must not break the
  // dev server), so a typo degrades into a missing alias and surfaces as
  //   "Failed to resolve import @synap-core/types/<sub>"
  // from an unrelated file. Measured 2026-10-07: renaming `attention.ts` to
  // `attention-order.ts` moved the KEY but left `./dist/attention.js` behind,
  // and the browser bundle was the only thing that noticed.
  const { readFileSync, existsSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));
  const broken = [];
  let checked = 0;
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (key === ".") continue;
    const targets =
      typeof target === "string"
        ? [target]
        : Object.values(target ?? {}).filter((v) => typeof v === "string");
    for (const file of targets) {
      if (file.includes("*")) continue; // wildcard keys resolve at call time
      checked += 1;
      if (!existsSync(resolve(pkgDir, file))) broken.push(`${key} -> ${file}`);
    }
  }
  if (broken.length > 0) {
    console.error(`Export sub-paths pointing at a file that does not exist:`);
    for (const b of broken) console.error(`  ${b}`);
    process.exit(1);
  }

  console.log(
    `All ${REQUIRED_RUNTIME_EXPORTS.length} runtime exports verified in dist/index.js and dist/events/index.js; ${GRANTS_RUNTIME_EXPORTS.length} in dist/grants/index.js; ${checked} export targets exist`
  );
}

verify();
