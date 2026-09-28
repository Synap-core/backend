/**
 * The shared relay↔web connections golden — pinned to THIS leaf.
 *
 * `__fixtures__/connections.golden.json` is the table both surfaces run their
 * OWN wire adapters over (relay: `relay-app/test/connections-parity.tripwire.
 * test.ts`; web: the browser twin). Its `expected` blocks are the leaf's
 * answer. This file keeps them true: if the leaf's rule changes, this goes red
 * here first, and the golden is regenerated deliberately — never drifts.
 *
 * The wire adapters live ONCE in `./wire.ts` (both hosts import them); this
 * file runs them over the table. Sameness is not correctness —
 * `connections.test.ts` pins the rule itself.
 *
 * `liveRows` are shapes captured from the deployed pod. The kind-card model is
 * built by each HOST's real builder (the kit, not reachable from here), so
 * this side runs the pipeline from `expectedDrawnKeys`; the hosts assert their
 * model draws exactly those keys, which is where "subtitle refs ignored" goes
 * red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  groupWireConnections,
  keyFactEntityIds,
  suggestWireConnections,
  type KindCardModelLike,
  type WireGraphNeighbor,
  type WireRelationType,
} from "./index.js";

interface Golden {
  groupRows: Array<{
    name: string;
    neighbors: WireGraphNeighbor[];
    relationTypes: WireRelationType[];
    keyFactIds: string[];
    cap?: number;
    expected: unknown;
  }>;
  suggestionRows: Array<{
    name: string;
    kind: string;
    defs: unknown[];
    expected: unknown;
  }>;
  keyFactRows: Array<{
    name: string;
    model: KindCardModelLike;
    expected: string[];
  }>;
  liveRows: Array<{
    name: string;
    neighbors: WireGraphNeighbor[];
    relationTypes: WireRelationType[];
    expectedDrawnKeys: string[];
    expected: { groups: Array<{ edgeType: string; label: string }> };
  }>;
}

const golden: Golden = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/connections.golden.json"), "utf8")
);

describe("connections golden (shared relay↔web table)", () => {
  it("is non-vacuous: every section has rows and the rows discriminate", () => {
    expect(golden.groupRows.length).toBeGreaterThanOrEqual(5);
    expect(golden.keyFactRows.length).toBeGreaterThanOrEqual(2);
    expect(golden.suggestionRows.length).toBeGreaterThanOrEqual(2);
    expect(golden.liveRows.length).toBeGreaterThanOrEqual(2);
    // A wire type with NO directionality must be in the table (the one input
    // where "absent ⇒ directional" and "=== unidirectional" disagree).
    expect(
      golden.groupRows.some((r) =>
        r.relationTypes.some((t) => t.directionality === undefined)
      )
    ).toBe(true);
    // Stored Title Case labels must be in the table, or casing is unguarded.
    expect(
      golden.liveRows.some((r) =>
        r.relationTypes.some((t) => /\b[A-Z][a-z]+ [A-Z]/.test(t.label ?? ""))
      )
    ).toBe(true);
    // The live person draws its company as TEXT — the name-key path.
    expect(
      golden.liveRows.some((r) =>
        r.expectedDrawnKeys.some((k) => k.startsWith("name:"))
      )
    ).toBe(true);
  });

  it.each(golden.groupRows.map((r) => [r.name, r] as const))(
    "%s",
    (_name, row) => {
      const out = groupWireConnections({
        neighbors: row.neighbors,
        relationTypes: row.relationTypes,
        keyFactIds: row.keyFactIds,
        ...(row.cap !== undefined ? { cap: row.cap } : {}),
      });
      expect(out).toEqual(row.expected);
    }
  );

  it.each(golden.keyFactRows.map((r) => [r.name, r] as const))(
    "%s",
    (_name, row) => {
      expect(keyFactEntityIds(row.model)).toEqual(row.expected);
    }
  );

  it.each(golden.liveRows.map((r) => [r.name, r] as const))(
    "%s",
    (_name, row) => {
      const out = groupWireConnections({
        neighbors: row.neighbors,
        relationTypes: row.relationTypes,
        keyFactIds: row.expectedDrawnKeys,
      });
      expect(out).toEqual(row.expected);
    }
  );

  it("live rows render once: no works_at under the person; the note keeps a same-titled but DIFFERENT object", () => {
    const [person, note] = golden.liveRows;
    expect(person!.expected.groups.map((g) => g.edgeType)).not.toContain(
      "works_at"
    );
    // Provenance is excluded by id only: a decision that merely shares the
    // capture's title is a real connection and must stay listed.
    expect(note!.expected.groups.map((g) => g.edgeType)).toContain(
      "created_by"
    );
    // Casing: every label is sentence case (no "Works At" / "Assigned To").
    for (const r of golden.liveRows) {
      for (const g of r.expected.groups)
        expect(g.label).not.toMatch(/ [A-Z][a-z]/);
    }
  });

  it.each(golden.suggestionRows.map((r) => [r.name, r] as const))(
    "%s",
    (_name, row) => {
      expect(suggestWireConnections(row.kind, row.defs)).toEqual(row.expected);
    }
  );
});
