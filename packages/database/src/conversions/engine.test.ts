/**
 * DB-less unit tests for the conversion engine's convertToFacet iteration.
 *
 * These do NOT open a database. A fake tagged-template `sql` routes each query
 * by a stable substring of its text and returns canned results, so we can prove
 * the JS orchestration in applyConvertToFacet — enumerate EVERY same-slug source
 * profile row, flip/attach/repoint each, aggregate the counts — without relying
 * on real SQL semantics (that half is dry-run-verified on the pod).
 */

import { describe, it, expect } from "vitest";
import type { Sql } from "postgres";
import { applyConvertToFacet } from "./engine.js";
import type { ConvertToFacetOp } from "./manifest.js";

type QueryResult = unknown;
type Handler = (text: string, values: unknown[]) => QueryResult;

/** Build a fake postgres.js `sql`: a tagged template + a `.json` helper. */
function makeFakeSql(handler: Handler): Sql {
  const fn: any = (
    strings: TemplateStringsArray | string[],
    ...values: unknown[]
  ) => {
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    return Promise.resolve(handler(text, values));
  };
  fn.json = (v: unknown) => ({ __json: v });
  return fn as Sql;
}

const baseOp: ConvertToFacetOp = {
  op: "convertToFacet",
  opKey: "test.convert.client",
  slug: "client",
  targetKindSlug: "company",
  applicableKinds: ["company", "person"],
  propertyMapping: { clientStatus: "clientStatus" },
};

/** Router shared by the happy-path tests. `sourceRows` seeds the enumeration. */
function router(opts: {
  sourceRows: Array<{ id: string; workspace_id: string | null }>;
  targetRows?: Array<{ id: string }>;
  facetCountPerRow?: number;
  repointCountPerRow?: number;
  calls: { flips: number; facetInserts: number; repoints: number };
}): Handler {
  return (text) => {
    if (text.includes("workspace_id FROM profiles")) return opts.sourceRows;
    if (text.includes("entity_facets")) {
      opts.calls.facetInserts += 1;
      return { count: opts.facetCountPerRow ?? 0 };
    }
    if (text.includes("UPDATE") && text.includes("entities e")) {
      opts.calls.repoints += 1;
      return { count: opts.repointCountPerRow ?? 0 };
    }
    if (text.includes("profile_kind = 'role'")) {
      opts.calls.flips += 1;
      return { count: 1 };
    }
    if (text.includes("ORDER BY")) return opts.targetRows ?? [];
    return null; // statusExpr / contextExpr fragments
  };
}

describe("applyConvertToFacet — multi-row source", () => {
  it("iterates EVERY same-slug source row and aggregates counts", async () => {
    const calls = { flips: 0, facetInserts: 0, repoints: 0 };
    const sql = makeFakeSql(
      router({
        sourceRows: [
          { id: "src-ws-a", workspace_id: "ws-a" },
          { id: "src-ws-b", workspace_id: "ws-b" },
        ],
        targetRows: [{ id: "company-system" }],
        facetCountPerRow: 2,
        repointCountPerRow: 3,
        calls,
      })
    );

    const counts = await applyConvertToFacet(sql, baseOp);

    // Two source rows, each flipped + faceted + repointed once.
    expect(calls.flips).toBe(2);
    expect(calls.facetInserts).toBe(2);
    expect(calls.repoints).toBe(2);
    // Counts sum across both rows.
    expect(counts.facetsCreated).toBe(4);
    expect(counts.entitiesConverted).toBe(6);
  });

  it("is a no-op when no active profile carries the slug", async () => {
    const calls = { flips: 0, facetInserts: 0, repoints: 0 };
    const sql = makeFakeSql(router({ sourceRows: [], calls }));

    const counts = await applyConvertToFacet(sql, baseOp);

    expect(counts).toEqual({});
    expect(calls.flips).toBe(0);
    expect(calls.repoints).toBe(0);
  });

  it("throws when a source row has no resolvable target kind", async () => {
    const calls = { flips: 0, facetInserts: 0, repoints: 0 };
    const sql = makeFakeSql(
      router({
        sourceRows: [{ id: "src-ws-a", workspace_id: "ws-a" }],
        targetRows: [], // target resolution finds nothing
        calls,
      })
    );

    await expect(applyConvertToFacet(sql, baseOp)).rejects.toThrow(
      /target kind profile 'company' not found/
    );
    // Threw before flipping anything on this row.
    expect(calls.flips).toBe(0);
  });
});
