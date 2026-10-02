#!/usr/bin/env node
/**
 * Publish the `posthog-analytics` capability to the ONE package catalog.
 *
 * `POST {SYNAP_CP_URL}/api/packages` → `publishPackageCore` is the ONLY write
 * door a package may enter the catalog through (see `TEMPLATE-DEV-GUIDE.md` and
 * the `synap-market` skill). There is no second registry, no npm publish and no
 * seed-on-deploy, so this script does exactly one thing: read the in-repo
 * definition, wrap it in the capability PACKAGE shape, and POST it.
 *
 * A pod then picks the row up from `cp_catalog_cache` and installs it — creating
 * the `posthog_api` vault:// tool (whose `baseUrl` pins host + project id) and
 * the four read-only verb rows the backend already registers handlers for.
 *
 * The definition file is a bare `CapabilityDefinition` (mirroring
 * `templates/loops/*.loop.json`). Publishing needs the PACKAGE wrapper
 * (`{slug, displayName, category, definition:{capability}}`), which this script
 * adds — a file that already carries `definition.capability` is published as-is.
 *
 * USAGE
 *   # Validate + print what would be sent. No network call. Always safe.
 *   node synap-backend/scripts/publish-posthog-capability.mjs --dry-run
 *
 *   # Live publish (needs a Personal Access Token that owns the vendor).
 *   SYNAP_CP_URL=https://api.synap.live \
 *   SYNAP_CP_PUBLISH_TOKEN=<pat> \
 *   node synap-backend/scripts/publish-posthog-capability.mjs [--public]
 *
 * WITHOUT a token the script forces a dry run — a publish is never an accident.
 * Default visibility is PRIVATE; pass `--public` to share it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFINITION_FILE = join(
  HERE,
  "../templates/capabilities/posthog-analytics.capability.json"
);

const SLUG = "posthog-analytics";
const DISPLAY_NAME = "PostHog Analytics";
const TAGS = ["analytics", "posthog", "product-analytics", "read-only"];

const args = new Set(process.argv.slice(2));
const forceDryRun = args.has("--dry-run");
const wantPublic = args.has("--public");

const CP_URL = process.env.SYNAP_CP_URL?.replace(/\/$/, "");
const TOKEN = process.env.SYNAP_CP_PUBLISH_TOKEN;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!CP_URL) {
  fail(
    "SYNAP_CP_URL is required (e.g. https://api.synap.live). It is needed even for --dry-run so the target is explicit."
  );
}

let definition;
try {
  definition = JSON.parse(readFileSync(DEFINITION_FILE, "utf8"));
} catch (err) {
  fail(`could not read ${DEFINITION_FILE}: ${err.message}`);
}

// Accept a bare CapabilityDefinition (the in-repo shape) or an already-wrapped
// package payload, and wrap only the former.
const capability = definition.definition?.capability ?? definition;
if (!capability?.key || !Array.isArray(capability.skills)) {
  fail(
    `${DEFINITION_FILE} is neither a CapabilityDefinition (key + skills[]) nor a package payload (definition.capability).`
  );
}

const body = {
  slug: SLUG,
  displayName: DISPLAY_NAME,
  description: capability.description?.slice(0, 500),
  category: "capability",
  isPublic: wantPublic,
  tags: TAGS,
  definition: { capability },
};

const verbNames = capability.skills.map((s) => s.name);

console.log(`\n${DISPLAY_NAME} (${SLUG}) — category: capability`);
console.log(`  verbs:      ${verbNames.join(", ")}`);
console.log(
  `  vault:      ${(capability.vault ?? []).map((v) => v.ref).join(", ") || "(none)"}`
);
console.log(
  `  tool:       ${capability.tools?.[0]?.name ?? "(none)"} → ${capability.tools?.[0]?.config?.baseUrl ?? "(no baseUrl)"}`
);
console.log(`  visibility: ${wantPublic ? "public" : "private (default)"}`);
console.log(`  door:       POST ${CP_URL}/api/packages`);

if (forceDryRun || !TOKEN) {
  console.log(
    `\n🔎 DRY RUN — nothing sent.${
      !TOKEN && !forceDryRun
        ? " SYNAP_CP_PUBLISH_TOKEN is unset, so a live publish was refused."
        : ""
    }`
  );
  console.log(
    `\nPayload preview:\n${JSON.stringify(body, null, 2).slice(0, 1200)}\n…\n`
  );
  process.exit(0);
}

console.log(`\n📡 Publishing…`);
const res = await fetch(`${CP_URL}/api/packages`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = text;
}

if (!res.ok) {
  console.error(`\n✖ publish failed (${res.status})`);
  console.error(
    typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
  );
  process.exit(1);
}

console.log(`\n✔ published (${res.status})`);
console.log(
  typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
);
console.log(
  "\nNext: install it on the pod (with the PostHog Personal API Key as a param):\n" +
    `  POST {podUrl}/api/hub/capabilities/apply\n` +
    `  { "templateKey": "${SLUG}", "params": { "personalApiKey": "phx_…", "projectId": "2", "analyticsHost": "https://analytics.synap.live" } }\n`
);
