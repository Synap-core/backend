/**
 * The presence challenge sweep (review of 6 Nov 2026, W3): `presence_challenges`
 * grew with every confirmation asked for. The hourly sweep deletes what expired
 * more than a day ago, answered or not, and keeps everything younger (a
 * challenge still open, a proof just made, a passkey-change grant not yet
 * redeemed).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
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

import {
  handlePresenceChallengeSweep,
  PRESENCE_CHALLENGE_RETENTION_HOURS,
} from "../presence-challenge-sweep.js";

const HOUR = 3600_000;
const NOW = new Date("2026-11-06T12:00:00Z");

async function insert(expiresAt: Date, consumed: boolean): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into presence_challenges (id, user_id, subject, nonce, expires_at, consumed_at)
     values ($1, 'p', 's', 'n', $2, $3)`,
    [id, expiresAt.toISOString(), consumed ? expiresAt.toISOString() : null]
  );
  return id;
}

beforeAll(async () => {
  await h.client!.exec(`
    create table presence_challenges (
      id uuid primary key, user_id text not null, subject text not null,
      nonce text not null, expires_at timestamptz not null, consumed_at timestamptz,
      redeemed_at timestamptz, method text, device_key_id uuid,
      created_at timestamptz not null default now());
  `);
});

describe("presence challenge sweep", () => {
  it("deletes what expired past the retention, answered or not, and keeps the rest", async () => {
    const past = new Date(
      NOW.getTime() - (PRESENCE_CHALLENGE_RETENTION_HOURS + 1) * HOUR
    );
    const recent = new Date(NOW.getTime() - HOUR);
    const open = new Date(NOW.getTime() + 60_000);
    const oldAnswered = await insert(past, true);
    const oldUnanswered = await insert(past, false);
    const keptRecent = await insert(recent, true);
    const keptOpen = await insert(open, false);

    expect(await handlePresenceChallengeSweep(NOW)).toBe(2);

    const { rows } = await h.client!.query<{ id: string }>(
      `select id from presence_challenges`
    );
    const left = rows.map((r) => r.id).sort();
    expect(left).toEqual([keptRecent, keptOpen].sort());
    expect(left).not.toContain(oldAnswered);
    expect(left).not.toContain(oldUnanswered);
    // A second run finds nothing more to delete.
    expect(await handlePresenceChallengeSweep(NOW)).toBe(0);
  });
});
