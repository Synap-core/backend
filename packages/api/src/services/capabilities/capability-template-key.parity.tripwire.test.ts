/**
 * Every door that gives a capability CONTAINER an address must write BOTH halves.
 *
 * `capabilities.template_key` (migration 0242) is the container's identity —
 * `(templateKey, scope)`, the Terraform-address shape — and it is the column the
 * unique index `capabilities_template_key_scope_uq` is built on. The same fact
 * ALSO lives in `metadata.templateKey`, which predates the column and is still
 * the read path for `workspace-to-package-definition.ts` (package export) and
 * `pod-config.ts` (provenance reporting).
 *
 * One fact, written twice, is a fork with a countdown. If a door stamps only the
 * metadata key, the row has no enforced address: the unique index does not see
 * it, name+scope resolution takes over, and the next apply mints the clone this
 * whole change exists to prevent — silently, because every UI surface collapses
 * containers by name. If a door stamps only the column, the package exporter
 * skips the container ("no inline shape to reconstruct losslessly") and the
 * capability vanishes from an exported workspace definition.
 *
 * These tests are SOURCE-PARSING on purpose (same idiom as
 * `capability-drift.projection-parity.tripwire.test.ts`): they read the writers'
 * own `.values({...})` / `.set({...})` blocks rather than re-listing them, so a
 * new container-creating door cannot pass by being unknown to a hand-maintained
 * list. Counted floors guard against a vacuous pass if the extraction breaks.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..", "..");

const WHY_IT_MATTERS =
  "capabilities.template_key is the container's ADDRESS and the column " +
  "capabilities_template_key_scope_uq enforces. A door that creates a container " +
  "without it leaves the row unaddressed: the unique index cannot see it, " +
  "resolution falls back to name+scope, and the next apply mints a duplicate " +
  "container that every UI surface then hides by collapsing on name. Thread " +
  "`templateKey` into this write (null is a legitimate value for a hand-made " +
  "container — but it must be a DECIDED null, present in the write).";

/** Every non-test .ts file under packages/api/src. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Extract the object literal a drizzle write passes, starting at `openIdx`
 * (the index of the `{` after `.values(` / `.set(`), by brace-matching.
 */
function objectLiteralAt(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced object literal");
}

/**
 * The ONE container insert block (`container-address.ts`) plus every CALL of
 * `resolveOrCreateContainer`. The doors no longer insert directly — enforced by
 * `__tripwires__/capability-container-one-insert-door.test.ts` — so the address
 * must be present at the door's own `.values({...})` AND at each caller, which
 * is where a forgotten `templateKey` would actually strand a container.
 */
function containerWriteBlocks(): Array<{
  file: string;
  block: string;
  kind: "insert" | "call";
}> {
  const found: Array<{ file: string; block: string; kind: "insert" | "call" }> =
    [];
  for (const file of sourceFiles(API_SRC)) {
    const src = readFileSync(file, "utf8");
    const patterns: Array<[RegExp, "insert" | "call"]> = [
      [
        /\.insert\((?:capabilities|capabilitiesTable)\)\s*\.values\(/g,
        "insert",
      ],
      [/resolveOrCreateContainer\(\s*\w+\s*,\s*/g, "call"],
    ];
    for (const [re, kind] of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        if (open === -1) continue;
        found.push({
          file: relative(API_SRC, file),
          block: objectLiteralAt(src, open),
          kind,
        });
      }
    }
  }
  return found;
}

describe("capability container address ↔ metadata parity", () => {
  it("the insert door and every caller of it write template_key", () => {
    const blocks = containerWriteBlocks();
    // Vacuous-pass guard. Three writes exist today: the single `.values({...})`
    // inside `container-address.ts`, and the two doors that call it — the tRPC
    // `capabilityContainers.create` procedure and the `capability/create`
    // proposal executor that mirrors it.
    expect(
      blocks.map((b) => `${b.kind}:${b.file}`).sort(),
      "extracted the wrong container-write set — the extraction is broken, not " +
        "the code under test"
    ).toEqual([
      "call:routers/capability-containers.ts",
      "call:routers/proposals/executors/capability.ts",
      "insert:services/capabilities/container-address.ts",
    ]);
    const missing = blocks
      .filter((b) => !/\btemplateKey\b/.test(b.block))
      .map((b) => b.file);
    expect(missing, `${missing.join(", ")}: ${WHY_IT_MATTERS}`).toEqual([]);
  });

  it("the applier stamps the COLUMN and the metadata key in the same write", () => {
    const src = readFileSync(join(here, "create-from-definition.ts"), "utf8");
    const anchor = src.indexOf(".update(capabilitiesTable)");
    expect(
      anchor,
      "the applier's container stamp block was not found — extraction broken"
    ).toBeGreaterThan(-1);
    const open = src.indexOf("{", src.indexOf(".set(", anchor));
    const block = objectLiteralAt(src, open);

    // The metadata half (what shipped first, and what the package exporter reads).
    const metaOpen = block.indexOf("{", block.indexOf("metadata:"));
    const metaBlock = objectLiteralAt(block, metaOpen);
    expect(
      /\btemplateKey:/.test(metaBlock),
      "the applier stopped stamping metadata.templateKey — " +
        "workspace-to-package-definition.ts skips any container without it, so " +
        "the capability silently disappears from an exported workspace definition"
    ).toBe(true);

    // The column half — outside the nested metadata literal.
    const withoutMetadata = block.replace(metaBlock, "");
    expect(
      /\btemplateKey:/.test(withoutMetadata),
      "the applier stamps metadata.templateKey but NOT the template_key column. " +
        WHY_IT_MATTERS
    ).toBe(true);
  });

  it("the shared resolver tries ADDRESS before name", () => {
    // Resolution moved out of the applier into `findContainerByAddress`, the one
    // place all three doors read the address from — so the ordering is asserted
    // where it now lives rather than deleted along with the inlined copy.
    const src = readFileSync(join(here, "container-address.ts"), "utf8");
    const byAddress = src.indexOf("eq(capabilities.templateKey");
    const byName = src.indexOf("eq(capabilities.name");
    expect(
      byAddress,
      "the resolver no longer looks a container up by template_key — a template " +
        "whose display NAME changed upstream will mint a second container next apply"
    ).toBeGreaterThan(-1);
    expect(
      byName,
      "the name fallback vanished — a pre-0242 container (stamped in " +
        "metadata but with a NULL column) would no longer be reused"
    ).toBeGreaterThan(-1);
    expect(
      byAddress < byName,
      "name+scope resolution runs BEFORE address resolution — a renamed template " +
        "then falls through to a create, minting the duplicate the address exists " +
        "to prevent"
    ).toBe(true);
    // And the applier must actually USE it rather than re-inlining a lookup.
    const applier = readFileSync(
      join(here, "create-from-definition.ts"),
      "utf8"
    );
    expect(
      applier,
      "create-from-definition.ts stopped resolving through the shared door"
    ).toMatch(/findContainerByAddress\(/);
  });

  it("the gate payload carries templateKey so an approved proposal is addressed", () => {
    const src = readFileSync(
      join(API_SRC, "routers", "capability-containers.ts"),
      "utf8"
    );
    const anchor = src.indexOf('subjectType: "capability"');
    expect(anchor, "the create gate was not found").toBeGreaterThan(-1);
    const dataOpen = src.indexOf("{", src.indexOf("data:", anchor));
    expect(
      /\btemplateKey:/.test(objectLiteralAt(src, dataOpen)),
      "checkPermissionOrPropose stores the create payload WITHOUT templateKey, so " +
        "an approved capability proposal materializes an unaddressed container — " +
        "the same class of defect as the 'empty shell' (name-only payload)"
    ).toBe(true);
  });
});
