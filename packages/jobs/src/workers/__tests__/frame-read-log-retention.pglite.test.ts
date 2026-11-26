/**
 * The frame read log retention (Surfaces P7): `frame_read_log` grows with
 * every read a framed surface asks for. The daily job deletes rows older than
 * FRAME_READ_LOG_RETENTION_DAYS (the inspect door's longest window) and keeps
 * everything younger, refused reads included.
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

import { FRAME_READ_LOG_RETENTION_DAYS } from "@synap/database/schema";
import { handleFrameReadLogRetention } from "../frame-read-log-retention.js";

const DAY = 86_400_000;
const NOW = new Date("2026-11-26T12:00:00Z");

async function insert(at: Date, allowed: boolean): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into frame_read_log (id, user_id, surface_kind, surface_key, op, params_hash, allowed, declared, at)
     values ($1, 'p', 'cell', 'k', 'entities.list', 'h', $2, true, $3)`,
    [id, allowed, at.toISOString()]
  );
  return id;
}

beforeAll(async () => {
  // The table as migration 0456 creates it.
  await h.client!.exec(`
    create table frame_read_log (
      id uuid primary key, user_id text not null, workspace_id uuid,
      surface_kind text not null, surface_key text not null, op text not null,
      params_hash text not null, allowed boolean not null, declared boolean not null,
      at timestamptz not null default now());
  `);
});

describe("frame read log retention", () => {
  it("deletes rows past the retention, answered or refused, and keeps the rest", async () => {
    const old = new Date(
      NOW.getTime() - (FRAME_READ_LOG_RETENTION_DAYS + 1) * DAY
    );
    const recent = new Date(NOW.getTime() - (FRAME_READ_LOG_RETENTION_DAYS - 1) * DAY);
    const oldAllowed = await insert(old, true);
    const oldRefused = await insert(old, false);
    const keptRecent = await insert(recent, false);
    const keptNow = await insert(NOW, true);

    expect(await handleFrameReadLogRetention(NOW)).toBe(2);

    const { rows } = await h.client!.query<{ id: string }>(
      `select id from frame_read_log`
    );
    const left = rows.map((r) => r.id).sort();
    expect(left).toEqual([keptRecent, keptNow].sort());
    expect(left).not.toContain(oldAllowed);
    expect(left).not.toContain(oldRefused);
    // A second run finds nothing more to delete.
    expect(await handleFrameReadLogRetention(NOW)).toBe(0);
  });

  it("keeps the 30 days the inspect door reads", () => {
    expect(FRAME_READ_LOG_RETENTION_DAYS).toBe(30);
  });
});
