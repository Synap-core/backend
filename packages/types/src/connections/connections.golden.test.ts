/**
 * The shared relay↔web connections golden — pinned to THIS leaf.
 *
 * `__fixtures__/connections.golden.json` is the table both surfaces run their
 * OWN wire adapters over (relay: `relay-app/test/connections-parity.tripwire.
 * test.ts`; web: the browser twin). Its `expected` blocks are the leaf's
 * answer. This file keeps them true: if the leaf's rule changes, this goes red
 * here first, and the golden is regenerated deliberately — never drifts.
 *
 * The adapters below are the SPEC of the wire mapping (C1 §3); each surface's
 * adapter must agree with it, which is exactly what their parity tests check.
 * Sameness is not correctness — `connections.test.ts` pins the rule itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupConnections, suggestConnections } from "./index.js";

interface Golden {
  groupRows: Array<{
    name: string;
    neighbors: Array<Record<string, unknown>>;
    relationTypes: Array<Record<string, unknown>>;
    keyFactIds: string[];
    cap?: number;
    expected: unknown;
  }>;
  suggestionRows: Array<{
    name: string;
    kind: string;
    defs: Array<Record<string, unknown>>;
    expected: unknown;
  }>;
  keyFactRows: Array<{ name: string; model: unknown; expected: string[] }>;
}

const golden: Golden = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/connections.golden.json"), "utf8")
);

describe("connections golden (shared relay↔web table)", () => {
  it("is non-vacuous: every section has rows and the rows discriminate", () => {
    expect(golden.groupRows.length).toBeGreaterThanOrEqual(4);
    expect(golden.keyFactRows.length).toBeGreaterThanOrEqual(2);
    expect(golden.suggestionRows.length).toBeGreaterThanOrEqual(2);
    // A wire type with NO directionality must be in the table (the one input
    // where "absent ⇒ directional" and "=== unidirectional" disagree).
    expect(
      golden.groupRows.some((r) =>
        r.relationTypes.some((t) => t.directionality === undefined)
      )
    ).toBe(true);
  });

  it.each(golden.groupRows.map((r) => [r.name, r] as const))(
    "%s",
    (_name, row) => {
      const out = groupConnections({
        neighbors: row.neighbors.map((n) => ({
          id: n.id as string,
          name: (n.name as string) ?? "",
          kind: n.kind as string,
          subtype: (n.subtype as string | null) ?? null,
          edgeType: (n.edgeType as string) ?? "",
          direction:
            n.direction === "incoming" || n.direction === "structural"
              ? (n.direction as "incoming" | "structural")
              : "outgoing",
          via: (n.via as string | null) ?? null,
        })),
        relationTypes: row.relationTypes.map((t) => ({
          slug: t.type as string,
          displayName: (t.label as string | null) ?? null,
          inverseLabel: (t.inverseLabel as string | null) ?? null,
          isDirectional: t.directionality !== "bidirectional",
        })),
        keyFactIds: row.keyFactIds,
        ...(row.cap !== undefined ? { cap: row.cap } : {}),
      });
      expect(out).toEqual(row.expected);
    }
  );

  it.each(golden.suggestionRows.map((r) => [r.name, r] as const))(
    "%s",
    (_name, row) => {
      const refs = row.defs.flatMap((d) => {
        const target = (d.uiHints as Record<string, unknown> | undefined)
          ?.linkedProfileSlug;
        return d.valueType === "entity_id" &&
          typeof target === "string" &&
          target
          ? [{ slug: d.slug as string, targetKind: target, relationType: null }]
          : [];
      });
      expect(
        suggestConnections(row.kind, { referenceProperties: refs })
      ).toEqual(row.expected);
    }
  );
});
