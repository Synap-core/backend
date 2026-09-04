/**
 * EVERY `links` EDGE A RULE WRITES MUST HAVE A READER.
 *
 * `linkRuleHalves` (`services/rules/index.ts`) writes the rule's lineage:
 *
 *   skill(rule)  --activates-->  automation(behaviour)
 *   skill(fact)  --documents-->  skill(rule)
 *
 * The `activates` edge shipped with ZERO readers. `rg '"activates"'` across the
 * backend returned four hits: two type declarations and two producers. Nothing
 * ever queried it — divergence detection and `skills.dryRunRule` resolved a
 * rule's automations from the JSONB copy in
 * `metadata.rule.behaviours[].automationId` instead. A write with no reader is
 * not a store; it is a claim nobody checks, and it is how "built but severed"
 * happens here over and over.
 *
 * ── WHY THIS PARSES THE APPLIER'S OWN SOURCE ────────────────────────────────
 * Precedent: `capability-drift.projection-parity.tripwire.test.ts`. The edge
 * list is DERIVED from `linkRuleHalves`'s literals, never hand-maintained here
 * — so adding a THIRD edge to the writer fails this test until a reader exists,
 * which is the whole point. A hand-written list would just be a second thing to
 * forget.
 *
 * ── WHY IT ASSERTS THE QUERY, NOT THE MENTION ───────────────────────────────
 * An import line satisfies a bare `toContain`. This asserts (a) the reader
 * module actually constrains all three of fromType / toType / linkType for each
 * edge, and (b) a real door CALLS the reader. Both halves were mutation-checked
 * against a deliberately broken tree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");

/** The APPLIER — the one place a rule writes `links` rows. */
const WRITER = "services/rules/index.ts";
/** The READER — the one place a rule's edges are queried back. */
const READER = "services/rules/lineage.ts";
/**
 * Doors that must actually CALL the reader. A reader nothing calls is the same
 * severance one level up.
 */
const CONSUMERS = ["routers/skills.ts"];

function read(rel: string): string {
  const path = join(API_SRC, rel);
  if (!existsSync(path)) throw new Error(`guarded file is missing: ${rel}`);
  return readFileSync(path, "utf8");
}

interface RuleEdge {
  fromType: string;
  toType: string;
  linkType: string;
}

/**
 * Pull the edges out of `linkRuleHalves`'s own body. Each literal is written in
 * declaration order (fromType, fromId, toType, toId, linkType), so the types
 * governing a `linkType` are the nearest preceding ones.
 */
function parseWrittenEdges(source: string): RuleEdge[] {
  const start = source.indexOf("export async function linkRuleHalves");
  if (start < 0) {
    throw new Error(
      "linkRuleHalves not found — the rule link WRITER was renamed or removed; " +
        "point this tripwire at its replacement rather than deleting it."
    );
  }
  const body = source.slice(start);
  const edges: RuleEdge[] = [];
  const linkTypeRe = /linkType:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkTypeRe.exec(body)) !== null) {
    const before = body.slice(0, m.index);
    const fromType = [
      ...before.matchAll(/fromType:\s*"([a-z_]+)"/g),
    ].pop()?.[1];
    const toType = [...before.matchAll(/toType:\s*"([a-z_]+)"/g)].pop()?.[1];
    if (!fromType || !toType) continue;
    edges.push({ fromType, toType, linkType: m[1]! });
  }
  return edges;
}

describe("every links edge a rule writes has a reader", () => {
  it("finds every file it claims to guard (never vacuously green)", () => {
    for (const rel of [WRITER, READER, ...CONSUMERS]) {
      expect(() => read(rel), rel).not.toThrow();
    }
  });

  const edges = parseWrittenEdges(read(WRITER));

  it("parses the edges out of the writer itself (never an empty sample)", () => {
    // Both edges exist today. A zero-length parse would make every assertion
    // below vacuous, which is exactly the failure mode a source-scan tripwire
    // has to rule out first.
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.map((e) => e.linkType)).toContain("activates");
    expect(edges.map((e) => e.linkType)).toContain("documents");
  });

  it.each(edges)(
    "skill --$linkType--> $toType is READ by services/rules/lineage.ts",
    (edge) => {
      const reader = read(READER);
      // The query must constrain all three axes. Matching only `linkType` would
      // pass on a reader that queries a completely different edge shape.
      expect(reader, `fromType "${edge.fromType}"`).toMatch(
        new RegExp(`links\\.fromType,\\s*"${edge.fromType}"`)
      );
      expect(reader, `toType "${edge.toType}"`).toMatch(
        new RegExp(`links\\.toType,\\s*"${edge.toType}"`)
      );
      expect(reader, `linkType "${edge.linkType}"`).toMatch(
        new RegExp(`"${edge.linkType}"\\s*as const`)
      );
      expect(reader, "the reader must query links").toMatch(/\.from\(links\)/);
    }
  );

  it("the reader is CALLED by a real door — not merely exported", () => {
    const exported = [
      ...read(READER).matchAll(/export async function (readRule\w+)/g),
    ].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThan(0);

    const consumerSource = CONSUMERS.map(read).join("\n");
    // Assert the CALL, not the import: `readRuleAutomationIds(` — an import
    // line alone is what let the first version of the sibling expiry tripwire
    // pass with its door un-wired.
    const called = exported.filter((name) =>
      new RegExp(`${name}\\s*\\(`).test(consumerSource)
    );
    expect(
      called,
      `these lineage readers are exported but never called: ${exported
        .filter((n) => !called.includes(n))
        .join(", ")}`
    ).toEqual(exported);
  });

  it("behaviours[].automationId is NOT read back as the membership list", () => {
    // The defect this wave removed: two stores for one fact, with the JSONB copy
    // winning. `behaviours[]` keeps ONLY the flowHash snapshot, keyed off the
    // edge. A `.map(b => b.automationId)` anywhere is the copy becoming the
    // store again.
    const suspects = [
      "services/rules/index.ts",
      "services/rules/create.ts",
      "routers/skills.ts",
      "routers/hub-protocol/rest/rules.ts",
    ];
    for (const rel of suspects) {
      expect(read(rel), rel).not.toMatch(
        /behaviours[\s\S]{0,40}\.map\(\s*\(?\s*b\)?\s*=>\s*b\.automationId/
      );
    }
  });
});
