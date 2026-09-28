/**
 * TRIPWIRE — the writes skill teaches "a typed thing with a file: the KIND
 * first, the bytes attached to it".
 *
 * Until 2026-09-28 `skills/synap/writes.md` ended its file decision at
 * "synap_store_file → a `file` entity" and never named `attachToEntityId`.
 * An agent storing a brand's logo therefore filed a bare `file` while the
 * space it was pinned to had a `brand-asset` kind for exactly that.
 *
 * Reachability, both ends: the recipe line names the parameter AND the
 * parameter really exists on the tool it names (read from the generated MCP
 * manifest, the same source the pod serves) — a recipe for a param the tool
 * dropped would be worse than none. The generated SKILL.md bundle is checked
 * too: a topic fix that was never rebuilt ships the old bundle.
 *
 * WHAT IT CANNOT SEE: a paraphrase, and the IS baseline mirror (held to this
 * file by `baseline-drift.test.ts` in synap-intelligence-service).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const WRITES = join(SKILLS_DIR, "synap/writes.md");
const BUNDLE = join(SKILLS_DIR, "synap/SKILL.md");
const MANIFEST = resolve(HERE, "../routers/mcp/tools/mcp-tools.manifest.json");

/** The recipe's anchor: store_file + attachToEntityId, in one paragraph. */
function recipeParagraph(md: string): string | undefined {
  return md
    .split(/\n\s*\n/)
    .find(
      (p) =>
        p.includes("attachToEntityId") &&
        p.includes("synap_store_file") &&
        /kind first/i.test(p)
    );
}

describe("tripwire: writes skill teaches kind-first file attach", () => {
  it("writes.md carries the recipe, naming a kind before the bytes", () => {
    const para = recipeParagraph(readFileSync(WRITES, "utf8"));
    expect(para, "writes.md lost the kind-first file recipe").toBeDefined();
    // The order is the lesson: resolve/create the entity, THEN store_file.
    expect(para!.indexOf("synap_create_entity")).toBeGreaterThan(-1);
    expect(para!.indexOf("synap_create_entity")).toBeLessThan(
      para!.indexOf("synap_store_file")
    );
  });

  it("the parameter it teaches exists on synap_store_file", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      tools: Array<{
        name: string;
        inputSchema?: { properties?: Record<string, unknown> };
      }>;
    };
    // Non-vacuity: the manifest parsed into a real tool list.
    expect(manifest.tools.length).toBeGreaterThan(20);
    const tool = manifest.tools.find((t) => t.name === "synap_store_file");
    expect(tool?.inputSchema?.properties).toHaveProperty("attachToEntityId");
  });

  it.skipIf(!existsSync(BUNDLE))(
    "the generated SKILL.md bundle carries it too (the bundle was rebuilt)",
    () => {
      expect(recipeParagraph(readFileSync(BUNDLE, "utf8"))).toBeDefined();
    }
  );
});
