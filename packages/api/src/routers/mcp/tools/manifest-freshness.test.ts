import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tools } from "./index.js";

/**
 * TRIPWIRE — the published MCP manifest is FRESH.
 *
 * `mcp-tools.manifest.json` is generated from `tools/index.ts` by
 * `gen-manifest.ts`, and it is not a build artifact you can ignore: the
 * Control Plane's `gen-pod-tools.ts` generates its curated `pod__*` surface
 * FROM this file, verbatim. So the chain is
 *
 *     tools/index.ts  →  mcp-tools.manifest.json  →  CP mcp-pod-tools.ts
 *
 * and a stale manifest means claude.ai is told a tool's contract that the pod
 * no longer has.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The SECOND hop was already guarded (`mcp-pod-tools-drift.test.ts` in the CP
 * repo). The FIRST hop was guarded only for ONE FIELD:
 * `intent-vocabulary-parity.test.ts` fails when a verb is added to the intent
 * union without a regen — but it compares the intent vocabulary, not the tool
 * schemas. So a new PROPERTY on a tool's `inputSchema` staled the manifest
 * silently.
 *
 * That is not hypothetical. In one session three separate schema edits shipped
 * against a stale manifest and were caught only because a human happened to
 * re-run the generator by hand:
 *   • `synap_create_skill` gained `slug` and dropped `code` from `required`.
 *   • `synap_capture`'s `workspaceRouting` description was rewritten (the old
 *     text documented behaviour the resolver did not have).
 *   • `synap_update_entity` gained `content` — the tool accepted a body edit
 *     in code while advertising, to every generated client, that it could not.
 *
 * Each is the same defect the rest of this codebase is consolidating: a
 * hand-maintained projection with nothing forcing it to track its source. A
 * guard that checks one field of a projection is a guard that reports green
 * over every other field — the `capability-drift` lesson, one artifact over.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
 * The whole `tools` array, derived: `tools.list()` IS what the generator
 * serializes, so this compares the committed file against its own source of
 * truth rather than against a hand-written expectation. Nothing here needs
 * updating when a tool changes — only the manifest does, which is the point.
 *
 * `instructions` is deliberately NOT compared: it is prose assembled from the
 * MCP router, importing which boots config/db and would make this test require
 * a database. The tool CONTRACTS are what generated clients are built from and
 * what drift actually breaks.
 *
 * FIX WHEN RED:  cd packages/api && pnpm gen:mcp-manifest
 * then re-sync the CP:  cd synap-control-plane-api && npx tsx scripts/gen-pod-tools.ts
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, "mcp-tools.manifest.json");

const REGEN_HINT =
  "The committed manifest is STALE. Regenerate it:\n" +
  "  cd packages/api && pnpm gen:mcp-manifest\n" +
  "then re-sync the Control Plane's curated copy:\n" +
  "  cd synap-control-plane-api && npx tsx scripts/gen-pod-tools.ts && npx prettier --write src/routes/mcp-pod-tools.ts";

describe("tripwire: the MCP manifest is generated from tools/index.ts, not maintained", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    tools: Array<{ name: string }>;
  };

  it("scans a real manifest — this test is not passing over nothing", () => {
    expect(
      Array.isArray(manifest.tools) && manifest.tools.length,
      "the manifest holds no tools array; the file or the generator shape changed"
    ).toBeGreaterThan(20);
  });

  it("every LIVE tool appears in the manifest", async () => {
    const live = await tools.list();
    expect(
      live.length,
      "tools.list() returned nothing — the import broke, so a comparison here would be vacuous"
    ).toBeGreaterThan(20);

    const shipped = new Set(manifest.tools.map((t) => t.name));
    const missing = live.map((t) => t.name).filter((n) => !shipped.has(n));
    expect(
      missing,
      `Tools exist in source but not in the manifest.\n${REGEN_HINT}`
    ).toEqual([]);
  });

  it("the manifest declares no tool that no longer exists", async () => {
    const live = new Set((await tools.list()).map((t) => t.name));
    const ghosts = manifest.tools
      .map((t) => t.name)
      .filter((n) => !live.has(n));
    expect(
      ghosts,
      `The manifest advertises tools the pod no longer has — the CP would publish them to claude.ai.\n${REGEN_HINT}`
    ).toEqual([]);
  });

  it("every tool's SCHEMA and description match source, byte for byte", async () => {
    const live = await tools.list();
    const byName = new Map(manifest.tools.map((t) => [t.name, t]));

    // Compare the serialized form, because that is exactly what the generator
    // writes and what the CP reads. A field-by-field comparison would be a
    // hand-maintained list of fields to check — the very defect this guards.
    const drifted = live
      .filter((t) => byName.has(t.name))
      .filter((t) => JSON.stringify(t) !== JSON.stringify(byName.get(t.name)))
      .map((t) => t.name);

    expect(
      drifted,
      `These tools changed in source without a manifest regen, so the CP is publishing their OLD contract.\n${REGEN_HINT}`
    ).toEqual([]);
  });
});
