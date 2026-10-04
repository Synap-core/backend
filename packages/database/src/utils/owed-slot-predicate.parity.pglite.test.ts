/**
 * PARITY: the owed-slot SQL (`owedSlotExistsIn`, every reaper + the needs-you
 * tray) answers exactly what the ONE deliverable rule answers —
 * `deliverableOwedBy(slot) === "you"` (`@synap-core/types/units`).
 *
 * BEHAVIOURAL, on PGlite: each fixture slot is run through the real rendered
 * SQL against a real Postgres, and through the real TypeScript rule.
 *
 * The rows are the inputs where naive spellings DISAGREE — each names what it
 * rules out:
 *   - `retiredAt: ""`   — `!retiredAt` (falsy) vs `IS NULL`: the pair split
 *                         the path row's tally from the tray's count once;
 *   - `status` absent / `null` — `->>'status' != 'done'` drops them (NULL);
 *   - `owner` absent    — `=== "agent"` / `!= 'human'` spellings disagree;
 *   - retired + human / retired + agent — retirement on one owner branch only;
 *   - JSON `false` / `0` stamps — a falsy test reads them as not retired.
 *
 * TEST-ONLY relative import of the authored rule: `@synap/database` cannot
 * depend on `@synap-core/types` (types depends on database — a build cycle);
 * tsconfig excludes tests, so this path never enters the database build. Same
 * pattern as `guideline-vocabulary-parity.test.ts`.
 *
 * The second block is the copy guard: no other pod source spells the
 * retirement clause (the blocked-slot scanner once carried its own copy of all
 * three clauses). Granularity: the `retiredAt` key in a `->>`/`->` SQL read —
 * a copy that spells only the other two clauses is NOT caught.
 *
 * WHAT THIS PROVES: SAMENESS of the SQL and the rule on these rows, never that
 * the rule is right. It does not cover the `jsonb_typeof` non-array guard (no
 * slot to compare) or `owedSlotOrder`'s ranking.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql } from "drizzle-orm";
import { OWED_SLOT_CLAUSES, owedSlotExistsIn } from "./owed-slot-predicate.js";
import { deliverableOwedBy } from "../../../types/src/units/deliverable.js";

const STAMP = "2026-09-08T13:00:00.000Z";

const ROWS: ReadonlyArray<{ rulesOut: string; slot: Record<string, unknown> }> =
  [
    { rulesOut: "!= 'done' on absent", slot: { owner: "human" } },
    {
      rulesOut: "!= 'done' on null",
      slot: { owner: "human", status: null },
    },
    {
      rulesOut: "=== 'pending' only",
      slot: { owner: "human", status: "in_progress" },
    },
    { rulesOut: "done still owed", slot: { owner: "human", status: "done" } },
    { rulesOut: "absent owner = human", slot: {} },
    { rulesOut: "agent = human", slot: { owner: "agent" } },
    {
      rulesOut: "retirement ignored",
      slot: { owner: "human", retiredAt: STAMP },
    },
    {
      rulesOut: "falsy retiredAt (empty stamp)",
      slot: { owner: "human", retiredAt: "" },
    },
    {
      rulesOut: "null stamp = retired",
      slot: { owner: "human", retiredAt: null },
    },
    {
      rulesOut: "falsy retiredAt (false)",
      slot: { owner: "human", retiredAt: false },
    },
    {
      rulesOut: "falsy retiredAt (0)",
      slot: { owner: "human", retiredAt: 0 },
    },
    {
      rulesOut: "retirement on the human branch only",
      slot: { owner: "agent", retiredAt: STAMP },
    },
    {
      rulesOut: "claim = delivered",
      slot: { owner: "human", claimedDone: true },
    },
  ];

let client: PGlite;
const dialect = new PgDialect();

async function sqlOwed(slot: Record<string, unknown>): Promise<boolean> {
  const q = dialect.sqlToQuery(
    owedSlotExistsIn(drizzleSql`${JSON.stringify([slot])}::jsonb`)
  );
  const res = await client.query<{ owed: boolean }>(
    `select ${q.sql} as owed`,
    q.params as unknown[]
  );
  return res.rows[0]!.owed;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("owed-slot SQL === deliverableOwedBy(slot) === 'you'", () => {
  it("non-vacuity: the table holds both answers and the clause set is real", async () => {
    expect(OWED_SLOT_CLAUSES.length).toBe(3);
    const answers = ROWS.map(
      (r) => deliverableOwedBy(r.slot as never) === "you"
    );
    expect(answers.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(answers.filter((a) => !a).length).toBeGreaterThanOrEqual(5);
    // The SQL can still see a literal owed slot, and a literal non-owed one.
    expect(await sqlOwed({ owner: "human" })).toBe(true);
    expect(await sqlOwed({ owner: "agent" })).toBe(false);
  });

  it("agrees on every discriminating row", async () => {
    for (const { rulesOut, slot } of ROWS) {
      expect({ rulesOut, slot, owed: await sqlOwed(slot) }).toEqual({
        rulesOut,
        slot,
        owed: deliverableOwedBy(slot as never) === "you",
      });
    }
  });
});

describe("no second copy of the owed-slot clauses in pod source", () => {
  const PACKAGES = join(__dirname, "../../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === "dist") return [];
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });

  it("only owed-slot-predicate.ts reads `retiredAt` in SQL", () => {
    const scanned = ["api", "jobs", "database"].flatMap((pkg) =>
      walk(join(PACKAGES, pkg, "src"))
    );
    expect(scanned.length).toBeGreaterThan(500); // non-vacuity
    const hits = scanned
      .filter((f) => /slot->>?'retiredAt'/.test(readFileSync(f, "utf8")))
      .map((f) => relative(PACKAGES, f));
    expect(hits).toEqual(["database/src/utils/owed-slot-predicate.ts"]);
  });
});
