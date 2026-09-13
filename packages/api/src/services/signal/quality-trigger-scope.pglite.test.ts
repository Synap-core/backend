/**
 * getQualityByVersion's trigger scope, on a real Postgres (PGlite) — the real
 * function, the real SQL predicate, rows read back.
 *
 * Discriminating inputs: a `capture.complete.completed` run and a
 * `hydration.imported.completed` run MUST be counted (the old
 * `external_message.received%`-only scope dropped both), and an
 * `entity.create.completed` / `channel_message.created.completed` run must NOT
 * (rules out a scope widened to "every automation run").
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getQualityByVersion } from "./index.js";

const A_EXT = "00000000-0000-4000-8000-00000000000a";
const A_CAP = "00000000-0000-4000-8000-00000000000b";
const A_HYD = "00000000-0000-4000-8000-00000000000c";
const A_ENT = "00000000-0000-4000-8000-00000000000d";
const A_CHM = "00000000-0000-4000-8000-00000000000e";
const R_CAP = "10000000-0000-4000-8000-00000000000b";

const run = (id: string, automationId: string, eventType: string, v: number) =>
  `('${id}', '${automationId}', null, '{"eventType":"${eventType}"}'::jsonb, '{"version":${v}}'::jsonb, now())`;

beforeAll(async () => {
  await h.client!.exec(`
    create table workspaces (id uuid primary key, owner_id text, settings jsonb);
    create table workspace_members (workspace_id uuid, user_id text);
    create table automations (id uuid primary key, name text, version int);
    create table automation_runs (
      id uuid primary key, automation_id uuid, workspace_id uuid,
      trigger_payload jsonb, definition_snapshot jsonb, started_at timestamptz
    );
    create table proposals (id uuid primary key default gen_random_uuid(), correlation_id uuid, workspace_id text);
    insert into automations values
      ('${A_EXT}', 'channel extraction', 1), ('${A_CAP}', 'screenshot goal', 3),
      ('${A_HYD}', 'import goal', 1), ('${A_ENT}', 'entity follow-up', 1),
      ('${A_CHM}', 'chat follow-up', 1);
    insert into automation_runs values
      ${run("10000000-0000-4000-8000-00000000000a", A_EXT, "external_message.received.completed", 1)},
      ${run(R_CAP, A_CAP, "capture.complete.completed", 3)},
      ${run("10000000-0000-4000-8000-00000000000c", A_HYD, "hydration.imported.completed", 1)},
      ${run("10000000-0000-4000-8000-00000000000d", A_ENT, "entity.create.completed", 1)},
      ${run("10000000-0000-4000-8000-00000000000e", A_CHM, "channel_message.created.completed", 1)};
    insert into proposals (correlation_id, workspace_id) values ('${R_CAP}', null);
  `);
});

describe("getQualityByVersion trigger scope", () => {
  it("counts channel, capture and import extraction runs — and nothing else", async () => {
    const out = await getQualityByVersion({ userId: "user-1" });

    expect(out.scanned).toBe(3);
    expect(out.automations.map((a) => a.automationId).sort()).toEqual(
      [A_EXT, A_CAP, A_HYD].sort()
    );
    const capture = out.automations.find((a) => a.automationId === A_CAP);
    expect(capture?.versions).toEqual([
      expect.objectContaining({
        version: 3,
        runs: 1,
        extracted: 1,
        extractionRatePct: 100,
      }),
    ]);
  });
});
