/**
 * "Later" on an owed ask (founder decision 9bc9f75c) — the door, on PGlite:
 *  - it stamps `laterUntil` on the owed slot (by key or label) and a second
 *    call moves the time; the needs-you rule then reads the slot as Review
 *    later until that time, and back in the headline after it;
 *  - it refuses a past time, a time beyond 30 days, another person's
 *    session, and an ask that is no longer owed;
 *  - Undo takes it back;
 *  - nothing else on the slot or its siblings changes.
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

import { classifyOwedAsk } from "@synap-core/types/needs-you";
import {
  askLaterReturnSlot,
  clearAskLater,
  runAskLaterReturn,
  setAskLater,
  stampAskLater,
  type ScheduleAskLaterReturn,
} from "./ask-later.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner-1";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const HOUR = 3_600_000;

const OWED = {
  key: "pick-a-name",
  label: "Pick a name",
  kind: "decision",
  owner: "human",
  owedSince: new Date(NOW.getTime() - HOUR).toISOString(),
  askedBy: "agent-1",
  ask: { mode: "confirm" },
};
const DONE = { key: "draft", label: "Draft", kind: "document", status: "done" };

const live = {
  status: "active",
  turnInFlight: false,
  lastAgentActivityAt: new Date(NOW.getTime() - HOUR).toISOString(),
  startedAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
};

async function slots(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await h.client!.query<{
    expected_outputs: Array<Record<string, unknown>>;
  }>(`SELECT expected_outputs FROM focus_sessions WHERE id = $1`, [SESSION]);
  return rows[0]!.expected_outputs;
}

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY,
      user_id text NOT NULL,
      expected_outputs jsonb
    );
  `);
});

beforeEach(async () => {
  await h.client!.exec(`DELETE FROM focus_sessions`);
  await h.client!.query(
    `INSERT INTO focus_sessions (id, user_id, expected_outputs) VALUES ($1, $2, $3::jsonb)`,
    [SESSION, OWNER, JSON.stringify([OWED, DONE])]
  );
});

describe("focusSessions.askLater — the door", () => {
  it("sets the owed ask aside: Review later until its time, back after it", async () => {
    const until = new Date(NOW.getTime() + 3 * HOUR);
    const saved = await setAskLater({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "pick-a-name",
      until,
      now: NOW,
    });
    expect(saved).toEqual({
      sessionId: SESSION,
      label: "Pick a name",
      laterUntil: until,
    });
    const [slot, sibling] = await slots();
    expect(slot).toEqual({ ...OWED, laterUntil: until.toISOString() });
    expect(sibling).toEqual(DONE);
    expect(classifyOwedAsk(slot!, live, NOW)).toBe("review_later");
    expect(classifyOwedAsk(slot!, live, until.getTime() + 1)).toBe("needs_you");
  });

  it("finds the ask by its label too, and a second call moves the time", async () => {
    const first = new Date(NOW.getTime() + HOUR);
    const second = new Date(NOW.getTime() + 24 * HOUR);
    await setAskLater({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "Pick a name",
      until: first,
      now: NOW,
    });
    await setAskLater({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "pick a name",
      until: second,
      now: NOW,
    });
    expect((await slots())[0]!.laterUntil).toBe(second.toISOString());
  });

  it("refuses a past time and one beyond 30 days, writing nothing", async () => {
    for (const until of [
      new Date(NOW.getTime() - 1),
      new Date(NOW.getTime() + 31 * 24 * HOUR),
    ]) {
      await expect(
        setAskLater({
          sessionId: SESSION,
          userId: OWNER,
          expectedLabel: "pick-a-name",
          until,
          now: NOW,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await slots())[0]).toEqual(OWED);
  });

  it("refuses another person's session and an ask that is no longer owed", async () => {
    const until = new Date(NOW.getTime() + HOUR);
    await expect(
      setAskLater({
        sessionId: SESSION,
        userId: "someone-else",
        expectedLabel: "pick-a-name",
        until,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      setAskLater({
        sessionId: SESSION,
        userId: OWNER,
        expectedLabel: "draft",
        until,
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await slots()).toEqual([OWED, DONE]);
  });

  it("Undo takes the Later back", async () => {
    await setAskLater({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "pick-a-name",
      until: new Date(NOW.getTime() + HOUR),
      now: NOW,
    });
    expect(
      await clearAskLater({
        sessionId: SESSION,
        userId: OWNER,
        expectedLabel: "pick-a-name",
      })
    ).toEqual({ cleared: true });
    expect((await slots())[0]).toEqual(OWED);
  });
});

describe("stampAskLater — pure", () => {
  it("never stamps a slot the person does not owe", () => {
    expect(stampAskLater([DONE as never], "draft", NOW)).toEqual({
      status: "not_owed",
    });
  });
});

describe("an ask back from Later (founder D3, 5 Nov 2026)", () => {
  const until = new Date(NOW.getTime() + 3 * HOUR);
  const scheduled: Array<{ payload: unknown; startAfter: Date }> = [];
  const schedule: ScheduleAskLaterReturn = async (payload, startAfter) => {
    scheduled.push({ payload, startAfter });
  };
  const notified: Array<Record<string, unknown>> = [];
  const notify = (async (p: Record<string, unknown>) => {
    notified.push(p);
    return true;
  }) as never;

  beforeEach(() => {
    scheduled.length = 0;
    notified.length = 0;
  });

  const later = (at: Date = until) =>
    setAskLater({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "pick-a-name",
      until: at,
      now: NOW,
      schedule,
    });
  const payload = (at: Date = until) => ({
    sessionId: SESSION,
    label: "Pick a name",
    laterUntil: at.toISOString(),
  });

  it("each Later schedules its return at its own time", async () => {
    await later();
    expect(scheduled).toEqual([{ payload: payload(), startAfter: until }]);
  });

  it("when the time comes, the person is told again through the one needs-you producer, as the asking agent", async () => {
    await later();
    expect(await runAskLaterReturn(payload(), { notify })).toEqual({
      status: "told",
    });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      sessionId: SESSION,
      byAgent: true,
      agentUserId: "agent-1",
      reason: {
        kind: "back",
        slot: { label: "Pick a name", laterUntil: until.toISOString() },
      },
    });
  });

  it("a stale return tells nobody: Undo, a later Later, an answered ask", async () => {
    await later();
    await clearAskLater({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "pick-a-name",
    });
    expect(await runAskLaterReturn(payload(), { notify })).toEqual({
      status: "stale",
    });

    await later();
    await later(new Date(NOW.getTime() + 24 * HOUR));
    expect(await runAskLaterReturn(payload(), { notify })).toEqual({
      status: "stale",
    });

    await h.client!.query(
      `UPDATE focus_sessions SET expected_outputs = $2::jsonb WHERE id = $1`,
      [
        SESSION,
        JSON.stringify([
          { ...OWED, owner: "agent", laterUntil: until.toISOString() },
          DONE,
        ]),
      ]
    );
    expect(await runAskLaterReturn(payload(), { notify })).toEqual({
      status: "stale",
    });
    expect(notified).toEqual([]);
  });

  it("askLaterReturnSlot — pure: the owed slot with exactly that Later, else nothing", () => {
    const stamped = { ...OWED, laterUntil: until.toISOString() } as never;
    expect(
      askLaterReturnSlot([stamped], "pick-a-name", until.toISOString())
    ).toBe(stamped);
    expect(
      askLaterReturnSlot([stamped], "pick-a-name", NOW.toISOString())
    ).toBeNull();
    expect(
      askLaterReturnSlot([OWED as never], "pick-a-name", until.toISOString())
    ).toBeNull();
  });
});
