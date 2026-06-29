#!/usr/bin/env node
/**
 * Generate src/services/capabilities/bundled-templates.generated.ts from the
 * on-disk template library (synap-backend/templates/capabilities/*.json).
 *
 * Run this whenever a template JSON changes:
 *   node packages/api/scripts/gen-bundled-templates.mjs
 *
 * WHY: compiling the templates into the bundle makes the capability catalog work
 * unconditionally — independent of whether the deploy image COPY'd templates/.
 * The on-disk COPY proved fragile (a lost layer => empty catalog => hidden door).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/api/scripts -> synap-backend/templates/capabilities
const dir = path.resolve(here, "../../../templates/capabilities");
const out = path.resolve(
  here,
  "../src/services/capabilities/bundled-templates.generated.ts"
);

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".capability.json"))
  .sort();

const entries = files.map((f) => {
  const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  const key = def.key || f.replace(/\.capability\.json$/, "");
  return [key, def];
});

const body = entries
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join("\n");

const ts = `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: synap-backend/templates/capabilities/*.capability.json
 * Regenerate: node packages/api/scripts/gen-bundled-templates.mjs
 *
 * WHY THIS EXISTS: the capability template library MUST be available at runtime
 * regardless of whether the deploy image bundled the templates/ directory. The
 * on-disk COPY proved fragile (a missing layer => an empty catalog => a hidden
 * door). Compiling the definitions into the bundle here makes discoverability
 * unconditional: tsup inlines this module, so the templates ship inside the
 * server binary and can never be "lost" by a Docker COPY or build cache.
 */
import type { CapabilityDefinition } from "@synap/playbooks";

const RAW = {
${body}
} as const;

export const BUNDLED_TEMPLATES = RAW as unknown as Record<string, CapabilityDefinition>;

export const BUNDLED_TEMPLATE_KEYS: string[] = Object.keys(RAW);
`;

fs.writeFileSync(out, ts);
console.log(
  `wrote ${path.relative(process.cwd(), out)} with ${entries.length} templates: ${entries
    .map((e) => e[0])
    .join(", ")}`
);
