/**
 * REAL-POSTGRES (PGlite) test for the boot-time enum floor
 * (`findMissingEnumValues`): a pod whose `governance_target` enum lacks a value
 * the schema declares must be reported at boot, not discovered at the first
 * insert. The query runs against real `pg_enum` / `pg_type`, through a
 * postgres.js-shaped tagged-template shim over PGlite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { findMissingEnumValues } from "./schema-coherence.js";
import { GOVERNANCE_TARGETS } from "../schema/governance-rules.js";

let pg: PGlite;

/** postgres.js `sql\`…\`` shape: interpolations become $n params, rows returned. */
function queryOver(db: PGlite) {
  return async <T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      ""
    );
    const res = await db.query(text, values);
    return res.rows as T;
  };
}

beforeEach(async () => {
  pg = new PGlite();
}, 120_000);

afterEach(async () => {
  await pg?.close();
});

describe("findMissingEnumValues — governance_target", () => {
  it("self-check: the drizzle enum declares `connection`", () => {
    expect(GOVERNANCE_TARGETS).toContain("connection");
  });

  it("a pod that skipped 0260 (no `connection`) is reported", async () => {
    await pg.exec(
      `CREATE TYPE governance_target AS ENUM ('action','profile','capability');`
    );
    await expect(findMissingEnumValues(queryOver(pg))).resolves.toEqual([
      { type: "governance_target", missing: ["connection"] },
    ]);
  });

  it("after 0260's ADD VALUE the enum is complete", async () => {
    await pg.exec(
      `CREATE TYPE governance_target AS ENUM ('action','profile','capability');`
    );
    await pg.exec(
      `ALTER TYPE governance_target ADD VALUE IF NOT EXISTS 'connection';`
    );
    await expect(findMissingEnumValues(queryOver(pg))).resolves.toEqual([]);
  });

  it("a missing enum type reports every declared value", async () => {
    await expect(findMissingEnumValues(queryOver(pg))).resolves.toEqual([
      { type: "governance_target", missing: [...GOVERNANCE_TARGETS] },
    ]);
  });
});
