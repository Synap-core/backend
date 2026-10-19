/**
 * Phone push hygiene, on real SQL (PGlite): the receipt check turns off only
 * the phones Expo reports dead, and the daily sweep only connected phones
 * unused for 90 days. Both are WHERE clauses — owner, provider, status, a
 * jsonb timestamp — so a fake db would only prove the fake.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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

import { handlePushDeviceSweep, handlePushReceipts } from "./push-devices.js";

const ADA = "ada";
const BOB = "bob";
const NOW = new Date("2026-10-19T03:00:00Z");
const daysAgo = (d: number) =>
  new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function phone(
  id: string,
  opts: {
    userId?: string;
    status?: string;
    provider?: string;
    lastSeenAt?: string;
  } = {}
) {
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, status, metadata)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      opts.userId ?? ADA,
      opts.provider ?? "expo",
      `ExponentPushToken[${id}]`,
      opts.status ?? "connected",
      JSON.stringify(opts.lastSeenAt ? { lastSeenAt: opts.lastSeenAt } : {}),
    ]
  );
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from messaging_accounts where id = $1`,
      [id]
    )
  ).rows[0]!.status;

function expoAnswers(data: Record<string, unknown>) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data }),
  })) as unknown as typeof fetch;
}

describe("phone push hygiene", () => {
  beforeAll(async () => {
    await h.client!.exec(`create table messaging_accounts (
      id text primary key, user_id text not null, workspace_id text,
      provider text not null, external_id text not null,
      display_name text not null default '', status text not null default 'connected',
      metadata jsonb not null default '{}', created_at timestamptz not null default now(),
      updated_at timestamptz not null default now())`);
  });

  beforeEach(async () => {
    await q(`delete from messaging_accounts`);
  });

  describe("receipts", () => {
    it("turns off only the phone Expo reports DeviceNotRegistered", async () => {
      await phone("live");
      await phone("dead");
      await phone("slow");
      const fetchFn = expoAnswers({
        t1: { status: "ok" },
        t2: { status: "error", details: { error: "DeviceNotRegistered" } },
        t3: { status: "error", details: { error: "MessageRateExceeded" } },
      });

      const out = await handlePushReceipts(
        {
          userId: ADA,
          tickets: [
            { ticketId: "t1", deviceId: "live" },
            { ticketId: "t2", deviceId: "dead" },
            { ticketId: "t3", deviceId: "slow" },
          ],
        },
        fetchFn
      );

      expect(out).toEqual({ checked: 3, disconnected: 1 });
      expect(await statusOf("live")).toBe("connected");
      expect(await statusOf("dead")).toBe("disconnected");
      // A transient error never unsubscribes a good phone.
      expect(await statusOf("slow")).toBe("connected");
      const body = JSON.parse(
        (vi.mocked(fetchFn).mock.calls[0]![1] as { body: string }).body
      );
      expect(body).toEqual({ ids: ["t1", "t2", "t3"] });
    });

    it("never rewrites a phone the person turned off, nor another person's", async () => {
      await phone("revoked", { status: "revoked" });
      await phone("bobs", { userId: BOB });
      const fetchFn = expoAnswers({
        t1: { status: "error", details: { error: "DeviceNotRegistered" } },
        t2: { status: "error", details: { error: "DeviceNotRegistered" } },
      });

      const out = await handlePushReceipts(
        {
          userId: ADA,
          tickets: [
            { ticketId: "t1", deviceId: "revoked" },
            { ticketId: "t2", deviceId: "bobs" },
          ],
        },
        fetchFn
      );

      expect(out.disconnected).toBe(0);
      expect(await statusOf("revoked")).toBe("revoked");
      expect(await statusOf("bobs")).toBe("connected");
    });

    it("fails the job when Expo cannot be reached, so it is retried", async () => {
      await phone("live");
      const fetchFn = vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof fetch;
      await expect(
        handlePushReceipts(
          { userId: ADA, tickets: [{ ticketId: "t1", deviceId: "live" }] },
          fetchFn
        )
      ).rejects.toThrow(/503/);
      expect(await statusOf("live")).toBe("connected");
    });
  });

  describe("unused-phone sweep", () => {
    it("turns off connected phones unused for 90 days, and nothing else", async () => {
      await phone("stale", { lastSeenAt: daysAgo(91) });
      await phone("recent", { lastSeenAt: daysAgo(89) });
      await phone("legacy");
      await phone("revoked", { status: "revoked", lastSeenAt: daysAgo(200) });
      await phone("not-a-phone", {
        provider: "linkedin",
        lastSeenAt: daysAgo(200),
      });

      await expect(handlePushDeviceSweep(NOW)).resolves.toBe(1);

      expect(await statusOf("stale")).toBe("disconnected");
      expect(await statusOf("recent")).toBe("connected");
      // No last-seen time: its age says nothing about use.
      expect(await statusOf("legacy")).toBe("connected");
      expect(await statusOf("revoked")).toBe("revoked");
      expect(await statusOf("not-a-phone")).toBe("connected");
    });
  });
});
