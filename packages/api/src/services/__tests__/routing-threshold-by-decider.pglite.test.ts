/**
 * `fetchWorkspaceRoutingThreshold` is stratified by DECIDER, on a real
 * Postgres (PGlite) running the function's real SQL.
 *
 * A JEV probability and an LLM's self-reported confidence are different
 * populations: the per-workspace gate a pick must clear is learned from route
 * decisions of the SAME decider only. Legacy route events (no `data.decider`)
 * were LLM picks and count as `llm`.
 *
 * The discriminating fixture: a workspace with MANY corrected LLM decisions but
 * a CLEAN JEV history. An unstratified tuner raises the JEV gate to the ceiling;
 * the stratified one keeps it at the floor.
 *
 * Stubbed: `db` → PGlite drizzle over a minimal `events` table (the columns the
 * function reads).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client);
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { fetchWorkspaceRoutingThreshold } from "../routing-memory.js";
import {
  AI_CORRECTION,
  AI_DECISION,
  AUTO_ROUTE_MIN_CONFIDENCE,
  ROUTE_TUNING_CEIL,
} from "../../lib/ai-events.js";

const USER = "user-1";
const WS = "ws-crm";

async function decision(
  decider: "jev" | "llm" | "legacy",
  corrected: boolean
): Promise<void> {
  const cid = randomUUID();
  await h.client!.query(
    `insert into events (type, subject_id, subject_type, data, correlation_id, user_id)
     values ('capture.route', $1, $2, $3::jsonb, $5::uuid, $4)`,
    [
      cid,
      AI_DECISION,
      JSON.stringify({
        kind: "route",
        chosenWorkspaceId: WS,
        confidence: 0.8,
        ...(decider === "legacy" ? {} : { decider }),
      }),
      USER,
      cid,
    ]
  );
  if (corrected) {
    await h.client!.query(
      `insert into events (type, subject_id, subject_type, data, user_id)
       values ('entity.moved', $1, $2, $3::jsonb, $4)`,
      [
        randomUUID(),
        AI_CORRECTION,
        JSON.stringify({ kind: "route", correlationId: cid }),
        USER,
      ]
    );
  }
}

async function many(
  n: number,
  decider: "jev" | "llm" | "legacy",
  corrected: boolean
) {
  for (let i = 0; i < n; i++) await decision(decider, corrected);
}

describe("fetchWorkspaceRoutingThreshold — stratified by decider (PGlite)", () => {
  beforeAll(async () => {
    await h.client!.exec(
      `create table events (
        id uuid not null default gen_random_uuid(),
        timestamp timestamptz not null default now(),
        type text not null,
        subject_id text not null,
        subject_type text not null,
        data jsonb not null,
        correlation_id uuid,
        user_id text not null
      );`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(`delete from events;`);
  });

  it("DISCRIMINATING: many corrected LLM decisions do NOT raise the gate for a JEV pick", async () => {
    await many(8, "llm", true);
    await many(6, "jev", false);
    expect(
      await fetchWorkspaceRoutingThreshold(USER, WS, { decider: "jev" })
    ).toBe(AUTO_ROUTE_MIN_CONFIDENCE);
    // Non-vacuity: the same history DOES raise the LLM gate to the ceiling.
    expect(
      await fetchWorkspaceRoutingThreshold(USER, WS, { decider: "llm" })
    ).toBe(ROUTE_TUNING_CEIL);
  });

  it("MIN_TUNING_VOLUME is per decider: 4 JEV decisions stay flat even beside 10 LLM ones", async () => {
    await many(10, "llm", true);
    await many(4, "jev", true);
    expect(
      await fetchWorkspaceRoutingThreshold(USER, WS, { decider: "jev" })
    ).toBeUndefined();
  });

  it("legacy events (no data.decider) count as llm, and llm is the default", async () => {
    await many(3, "legacy", true);
    await many(2, "llm", false);
    await many(5, "jev", false);
    const expected =
      AUTO_ROUTE_MIN_CONFIDENCE +
      (3 / 5) * (ROUTE_TUNING_CEIL - AUTO_ROUTE_MIN_CONFIDENCE);
    expect(await fetchWorkspaceRoutingThreshold(USER, WS)).toBeCloseTo(
      expected,
      10
    );
    expect(
      await fetchWorkspaceRoutingThreshold(USER, WS, { decider: "llm" })
    ).toBeCloseTo(expected, 10);
  });

  it("a JEV pick's own misses DO raise the JEV gate", async () => {
    await many(5, "jev", true);
    await many(5, "llm", false);
    expect(
      await fetchWorkspaceRoutingThreshold(USER, WS, { decider: "jev" })
    ).toBe(ROUTE_TUNING_CEIL);
    expect(
      await fetchWorkspaceRoutingThreshold(USER, WS, { decider: "llm" })
    ).toBe(AUTO_ROUTE_MIN_CONFIDENCE);
  });
});
