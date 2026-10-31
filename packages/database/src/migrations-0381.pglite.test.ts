/**
 * REAL-POSTGRES (PGlite) test for migration 0381 — "Never" and "Later" on a
 * request (founder decision G3):
 *  - `governance_verdict` gains `deny`, after `auto` and `propose`;
 *  - `proposal_snoozes` holds ONE row per (proposal, person): a second
 *    "Later" by the same person moves the time, another person keeps theirs;
 *  - a snooze goes with its proposal (ON DELETE CASCADE);
 *  - idempotent (applied twice).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0381_governance_deny_and_request_later.sql"),
  "utf8"
);

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE governance_verdict AS ENUM ('auto', 'propose');
    CREATE TABLE proposals (id uuid PRIMARY KEY, status text NOT NULL);
    INSERT INTO proposals (id, status) VALUES ('${P1}', 'pending'), ('${P2}', 'pending');
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

const snoozesOf = async (proposalId: string) =>
  (
    await pg.query<{ user_id: string; until: string }>(
      `SELECT user_id, snoozed_until::text AS until FROM proposal_snoozes
        WHERE proposal_id = $1 ORDER BY user_id`,
      [proposalId]
    )
  ).rows;

const later = (proposalId: string, userId: string, until: string) =>
  pg.query(
    `INSERT INTO proposal_snoozes (proposal_id, user_id, snoozed_until)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (proposal_id, user_id) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until`,
    [proposalId, userId, until]
  );

describe("0381 Never and Later", () => {
  it("adds deny to governance_verdict", async () => {
    const { rows } = await pg.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::governance_verdict))::text AS v`
    );
    expect(rows.map((r) => r.v)).toEqual(["auto", "propose", "deny"]);
  });

  it("keeps one Later per person per request; a second one moves the time", async () => {
    await later(P1, "ana", "2026-11-01T08:00:00Z");
    await later(P1, "ben", "2026-11-02T08:00:00Z");
    await later(P1, "ana", "2026-11-03T08:00:00Z");
    const rows = await snoozesOf(P1);
    expect(rows.map((r) => r.user_id)).toEqual(["ana", "ben"]);
    expect(rows[0]!.until).toMatch(/^2026-11-03/);
    expect(rows[1]!.until).toMatch(/^2026-11-02/);
  });

  it("a Later goes with its request", async () => {
    await later(P2, "ana", "2026-11-01T08:00:00Z");
    await pg.query(`DELETE FROM proposals WHERE id = $1`, [P2]);
    expect(await snoozesOf(P2)).toEqual([]);
  });

  it("refuses a Later on a request that does not exist", async () => {
    await expect(
      later(
        "33333333-3333-4333-8333-333333333333",
        "ana",
        "2026-11-01T08:00:00Z"
      )
    ).rejects.toThrow();
  });
});
