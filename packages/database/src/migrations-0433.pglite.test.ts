/**
 * REAL-POSTGRES (PGlite) test for migration 0433 — a criterion names the
 * output it checks (work-model W4). A minimal `focus_sessions` table carries
 * the columns the migration reads; it runs TWICE.
 *
 * Each row names what it rules out:
 *   - a same-key pair left unpaired (the pairing switch would orphan it);
 *   - a legacy slot with no stored key missed (its key is its label's slug);
 *   - a criterion with no slot of its key, or only a param / escalated
 *     criterion slot of its key, given an outputKey;
 *   - a criterion that already names an output rewritten;
 *   - criteria reordered, or a session with no pair rewritten;
 *   - a non-array bag breaking the migration.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0433 = readFileSync(
  resolve(HERE, "../migrations/0433_criteria_name_their_output.sql"),
  "utf8"
);

let pg: PGlite;

const judge = { kind: "judge" };
const PAIRED = randomUUID();
const UNPAIRED = randomUUID();
const MALFORMED = randomUUID();

const PAIRED_SLOTS = [
  { kind: "document", label: "Wave plan", key: "plan" },
  // A legacy slot: no stored key, its key is the slug of its label.
  { kind: "report", label: "Lead list (EU)" },
  { kind: "playbook_param", label: "Region", key: "region" },
  { kind: "criterion", label: "Grade", key: "grade", criterionKey: "tests" },
  { kind: "document", label: "Spec", key: "spec" },
];
const PAIRED_CRITERIA = [
  { key: "tests", statement: "Tests pass", check: judge },
  { key: "plan", statement: "The plan is sound", check: judge },
  { key: "lead-list-eu", statement: "Leads are EU", check: judge },
  { key: "region", statement: "Region chosen", check: judge },
  { key: "grade", statement: "Graded", check: judge },
  {
    key: "spec",
    statement: "Spec reviewed",
    check: judge,
    outputKey: "plan",
  },
];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY, criteria jsonb, expected_outputs jsonb, touched int NOT NULL DEFAULT 0);
    CREATE FUNCTION touch() RETURNS trigger AS $$
    BEGIN NEW.touched := OLD.touched + 1; RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER t BEFORE UPDATE ON focus_sessions FOR EACH ROW EXECUTE FUNCTION touch();
  `);
  const insert = (id: string, criteria: unknown, slots: unknown) =>
    pg.query(
      `INSERT INTO focus_sessions (id, criteria, expected_outputs) VALUES ($1, $2::jsonb, $3::jsonb)`,
      [id, JSON.stringify(criteria), JSON.stringify(slots)]
    );
  await insert(PAIRED, PAIRED_CRITERIA, PAIRED_SLOTS);
  await insert(
    UNPAIRED,
    [{ key: "fast", statement: "It is fast", check: judge }],
    [{ kind: "document", label: "Notes", key: "notes" }]
  );
  await insert(MALFORMED, { not: "an array" }, "nor this");
  await pg.exec(M0433);
  await pg.exec(M0433);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

async function row(id: string) {
  const r = await pg.query<{
    criteria: Array<Record<string, unknown>>;
    touched: number;
  }>(`SELECT criteria, touched FROM focus_sessions WHERE id = $1`, [id]);
  return r.rows[0]!;
}

describe("migration 0433 — criteria name the output they share a key with", () => {
  it("pairs exactly the same-key criteria with an outcome slot, in place", async () => {
    const { criteria } = await row(PAIRED);
    expect(criteria.map((c) => [c.key, c.outputKey])).toEqual([
      ["tests", undefined],
      ["plan", "plan"],
      ["lead-list-eu", "lead-list-eu"],
      ["region", undefined],
      ["grade", undefined],
      ["spec", "plan"],
    ]);
    // Nothing else on a criterion moves.
    expect(criteria[1]).toEqual({ ...PAIRED_CRITERIA[1], outputKey: "plan" });
  });

  it("rewrites a paired session once across two runs, and never one with no pair", async () => {
    expect((await row(PAIRED)).touched).toBe(1);
    expect((await row(UNPAIRED)).touched).toBe(0);
    expect((await row(MALFORMED)).touched).toBe(0);
  });
});
