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

  console.log(
    `All ${REQUIRED_RUNTIME_EXPORTS.length} runtime exports verified in dist/index.js and dist/events/index.js`
  );
}

verify();
