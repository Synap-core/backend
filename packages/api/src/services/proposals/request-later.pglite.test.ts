/**
 * "Later" on a request (founder decision G3) — the door, on PGlite:
 *  - it sets the request aside for the CALLER only, and a second call moves
 *    the time;
 *  - the needs-you classifier then reads it as Review later for that caller,
 *    and unchanged for another reader;
 *  - it refuses a past time, a time beyond 30 days, and a decided request;
 *  - Undo takes it back.
 *
 * The visibility check has its own tests (`proposal-visibility`); here it is
 * stubbed to "visible" so the door's own rules are what is measured.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

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

vi.mock("../../utils/proposal-visibility.js", () => ({
  assertProposalVisibleTo: async () => undefined,
}));

// The classifier's other reads (what waits, the session) are not what this
// file measures: nothing waits, so an un-snoozed request is a change to review.
vi.mock("./proposal-waits.js", () => ({
  resolveProposalWaits: async () => new Map(),
}));

import { setRequestLater, clearRequestLater } from "./request-later.js";
import { classifyPendingProposals } from "./proposal-needs-you.js";

const PENDING = "11111111-1111-4111-8111-111111111111";
const DECIDED = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE proposals (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE proposal_snoozes (
      proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      snoozed_until timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (proposal_id, user_id)
    );
    INSERT INTO proposals (id, status) VALUES
      ('${PENDING}', 'pending'), ('${DECIDED}', 'approved');
  `);
});

beforeEach(async () => {
  await h.client!.exec(`DELETE FROM proposal_snoozes`);
});

const row = {
  id: PENDING,
  proposalType: "update",
  status: "pending",
  sessionId: null,
  createdAt: new Date(NOW.getTime() - HOUR),
};

describe("proposals.later — the door", () => {
  it("sets the request aside for the caller, Review later for them only", async () => {
    const until = new Date(NOW.getTime() + 3 * HOUR);
    const saved = await setRequestLater({
      proposalId: PENDING,
      userId: "ana",
      until,
      now: NOW,
    });
    expect(saved.snoozedUntil.getTime()).toBe(until.getTime());

    const forAna = await classifyPendingProposals(
      [row],
      { userId: "ana" },
      NOW
    );
    const forBen = await classifyPendingProposals(
      [row],
      { userId: "ben" },
      NOW
    );
    expect(forAna.get(PENDING)).toBe("review_later");
    expect(forBen.get(PENDING)).toBe("changes_to_review");
  });

  it("comes back on its own once the time passes", async () => {
    await setRequestLater({
      proposalId: PENDING,
      userId: "ana",
      until: new Date(NOW.getTime() + HOUR),
      now: NOW,
    });
    const after = new Date(NOW.getTime() + 2 * HOUR);
    expect(
      (await classifyPendingProposals([row], { userId: "ana" }, after)).get(
        PENDING
      )
    ).toBe("changes_to_review");
  });

  it("a second Later moves the time", async () => {
    await setRequestLater({
      proposalId: PENDING,
      userId: "ana",
      until: new Date(NOW.getTime() + HOUR),
      now: NOW,
    });
    await setRequestLater({
      proposalId: PENDING,
      userId: "ana",
      until: new Date(NOW.getTime() + 48 * HOUR),
      now: NOW,
    });
    const { rows } = await h.client!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proposal_snoozes`
    );
    expect(rows[0]!.n).toBe(1);
    expect(
      (
        await classifyPendingProposals(
          [row],
          { userId: "ana" },
          new Date(NOW.getTime() + 24 * HOUR)
        )
      ).get(PENDING)
    ).toBe("review_later");
  });

  it("refuses a past time and a time beyond 30 days", async () => {
    await expect(
      setRequestLater({
        proposalId: PENDING,
        userId: "ana",
        until: new Date(NOW.getTime() - HOUR),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setRequestLater({
        proposalId: PENDING,
        userId: "ana",
        until: new Date(NOW.getTime() + 31 * 24 * HOUR),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a decided request", async () => {
    await expect(
      setRequestLater({
        proposalId: DECIDED,
        userId: "ana",
        until: new Date(NOW.getTime() + HOUR),
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("Undo takes it back", async () => {
    await setRequestLater({
      proposalId: PENDING,
      userId: "ana",
      until: new Date(NOW.getTime() + HOUR),
      now: NOW,
    });
    expect(
      await clearRequestLater({ proposalId: PENDING, userId: "ana" })
    ).toEqual({ cleared: true });
    expect(
      (await classifyPendingProposals([row], { userId: "ana" }, NOW)).get(
        PENDING
      )
    ).toBe("changes_to_review");
    expect(
      await clearRequestLater({ proposalId: PENDING, userId: "ana" })
    ).toEqual({ cleared: false });
  });
});
