import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * materializeScheduledSession — the ONE producer of
 * `focus_sessions.status = 'scheduled'`, and the accumulation policy that keeps
 * it from becoming a graveyard.
 *
 * What is pinned here, and why each one is a real failure mode:
 *
 *  1. A FRESH appointment is born `scheduled`. `SCHEDULED` sat in the status
 *     union with ZERO writers; asserting the value that reaches
 *     `instantiateSession` is what makes this producer real rather than declared.
 *  2. An UNOPENED appointment is ROLLED FORWARD, not duplicated. The prior-art
 *     failure is unconditional scheduled runs piling up unread until the surface
 *     dies. One row, re-dated, with the miss made visible.
 *  3. The miss counter INCREMENTS across slots. Roll-forward without a counter
 *     erases the fact that you skipped it four times.
 *  4. An unbound (subject-less) appointment finds its OWN predecessor. This is
 *     the `eq(col, null)` trap: `= NULL` is never true, so an unbound appointment
 *     would miss itself and create a new row EVERY SINGLE SLOT — the exact
 *     accumulation the policy exists to prevent, and it would look fine in
 *     review.
 *  5. A roll-forward whose guarded UPDATE matches 0 rows (the human opened the
 *     appointment between the read and the write) FALLS THROUGH to creating the
 *     next one, rather than silently doing nothing.
 *
 * The database is MOCKED — this asserts the state machine and which query
 * builders each branch reaches, NOT the emitted SQL. What it therefore does NOT
 * cover, stated plainly: that `eq`/`isNull`/`and` compose into a predicate
 * Postgres accepts, and that the partial predicate actually selects the right
 * row. That needs a live pod (NEEDS-DOGFOOD).
 */

const {
  findFirstMock,
  setMock,
  returningMock,
  updateMock,
  instantiateMock,
  resolvePlaybookMock,
  isNullMock,
  eqMock,
  whereMock,
} = vi.hoisted(() => {
  const returningMock = vi.fn();
  const whereMock = vi.fn((_predicate?: unknown) => ({
    returning: returningMock,
  }));
  const setMock = vi.fn((_values?: unknown) => ({ where: whereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  return {
    findFirstMock: vi.fn(),
    setMock,
    whereMock,
    returningMock,
    updateMock,
    instantiateMock: vi.fn(async () => ({
      id: "sess-new",
      status: "scheduled",
      channelId: null,
    })),
    resolvePlaybookMock: vi.fn(async () => ({
      id: "pb-1",
      goalTemplate: "Weekly review",
    })),
    isNullMock: vi.fn((c: unknown) => ({ op: "isNull", c })),
    eqMock: vi.fn((c: unknown, v: unknown) => ({ op: "eq", c, v })),
  };
});

/**
 * PARTIAL mock (`importOriginal` + spread), not a total one — see
 * `src/__tripwires__/database-mock-total-ratchet.test.ts`. A total mock dies at
 * COLLECTION time the moment the module under test starts using an export the
 * hand-listed object does not name, and takes the whole file dark with it. That
 * is not hypothetical here: this file's own subject grew a `workspaceId` /
 * `userId` read mid-wave.
 *
 * The predicate builders and the columns ARE still replaced with sentinels
 * below, deliberately: these tests assert the SHAPE of the WHERE clause
 * (`eqPairs` walks the recorded `and`/`eq` tree), which real Drizzle values
 * would bury inside opaque SQL objects. `@synap/database`'s clients are
 * lazy-connect, so importing the real module opens no socket — verified by
 * running this file with Postgres down.
 */
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({
      query: { focusSessions: { findFirst: findFirstMock } },
      update: updateMock,
    }),
    eq: eqMock,
    and: (...parts: unknown[]) => ({ op: "and", parts }),
    desc: (c: unknown) => ({ op: "desc", c }),
    isNull: isNullMock,
    focusSessions: {
      playbookId: "col:playbookId",
      status: "col:status",
      subjectEntityId: "col:subjectEntityId",
      startedAt: "col:startedAt",
      id: "col:id",
      workspaceId: "col:workspaceId",
      userId: "col:userId",
    },
  };
});
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../playbooks/playbook-lifecycle.js", () => ({
  instantiateSession: instantiateMock,
  resolveRunnablePlaybook: resolvePlaybookMock,
}));

import {
  materializeScheduledSession,
  SCHEDULED_FOR_METADATA_KEY,
  SCHEDULED_MISSED_COUNT_METADATA_KEY,
  SCHEDULED_BY_METADATA_KEY,
} from "../schedule-session.js";

const SLOT_1 = new Date("2026-09-07T09:00:00.000Z");
const SLOT_2 = new Date("2026-09-14T09:00:00.000Z");

const base = {
  playbookId: "pb-1",
  workspaceId: "ws-1",
  userId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue(undefined);
  instantiateMock.mockResolvedValue({
    id: "sess-new",
    status: "scheduled",
    channelId: null,
  });
  resolvePlaybookMock.mockResolvedValue({
    id: "pb-1",
    goalTemplate: "Weekly review",
  });
});

describe("materializeScheduledSession — a fresh appointment", () => {
  it("is born `scheduled` via instantiateSession, with its slot stamped", async () => {
    const result = await materializeScheduledSession({
      ...base,
      subjectId: "ent-1",
      scheduledFor: SLOT_1,
    });

    expect(instantiateMock).toHaveBeenCalledTimes(1);
    const arg = (instantiateMock.mock.calls as unknown[][])[0][0] as {
      status?: string;
      subjectId?: string | null;
      metadata?: Record<string, unknown>;
    };
    // THE producer assertion: the value that had no writer now arrives.
    expect(arg.status).toBe("scheduled");
    expect(arg.subjectId).toBe("ent-1");
    expect(arg.metadata?.[SCHEDULED_FOR_METADATA_KEY]).toBe(
      SLOT_1.toISOString()
    );
    expect(arg.metadata?.[SCHEDULED_MISSED_COUNT_METADATA_KEY]).toBe(0);

    expect(result).toMatchObject({ outcome: "created", missedCount: 0 });
    // Nothing was updated — no prior appointment existed.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('carries `origin: "human"` — the operator AUTHORED the recurrence', () => {
    // Asserted as its own case because it is the value a future reader is most
    // likely to "fix": a cron created the row, so `automation` looks right. It
    // is not. `origin` records WHO AUTHORED the session, and the person who
    // wrote the weekly schedule authored this one; `automation` would push it
    // into the triage lens and ask them to re-accept what they already asked for
    // every week.
    return materializeScheduledSession({
      ...base,
      scheduledFor: SLOT_1,
    }).then(() => {
      const arg = (instantiateMock.mock.calls as unknown[][])[0][0] as {
        origin?: string;
      };
      expect(arg.origin).toBe("human");
    });
  });

  it("records WHAT materialized it under a NESTED `scheduledBy`, never top-level automation keys", async () => {
    await materializeScheduledSession({
      ...base,
      scheduledFor: SLOT_1,
      scheduledBy: { automationId: "auto-7", automationRunId: "run-7" },
    });
    const meta = (
      (instantiateMock.mock.calls as unknown[][])[0][0] as {
        metadata?: Record<string, unknown>;
      }
    ).metadata!;

    // Provenance is NOT lost by `origin:"human"` — it moved to its own field.
    expect(meta[SCHEDULED_BY_METADATA_KEY]).toEqual({
      playbookId: "pb-1",
      automationId: "auto-7",
      automationRunId: "run-7",
    });

    // …and it is NESTED. `session-kind.ts` reads `automationId` /
    // `automationRunId` at the metadata bag's TOP LEVEL and classifies any row
    // carrying either as `kind:'run'`, which the Work lens excludes. Flattening
    // this object would hide the appointment from the one screen it exists for,
    // silently, with every type green.
    expect(meta.automationId).toBeUndefined();
    expect(meta.automationRunId).toBeUndefined();
  });

  it("does NOT create a run: it only reaches instantiateSession", async () => {
    // The whole difference from runPlaybook is what is ABSENT. There is no
    // channel write, no playbook_runs insert and no executor dispatch anywhere
    // in this module — `db.insert` is not even in the mock surface, so a future
    // edit that adds one fails loudly here rather than shipping an appointment
    // that quietly starts an agent.
    await materializeScheduledSession({ ...base, scheduledFor: SLOT_1 });
    expect(instantiateMock).toHaveBeenCalledTimes(1);
  });
});

describe("materializeScheduledSession — an appointment nobody opened", () => {
  it("ROLLS THE SAME ROW FORWARD instead of creating a second one", async () => {
    findFirstMock.mockResolvedValue({
      id: "sess-old",
      status: "scheduled",
      metadata: {
        [SCHEDULED_FOR_METADATA_KEY]: SLOT_1.toISOString(),
        [SCHEDULED_MISSED_COUNT_METADATA_KEY]: 0,
        keepMe: "prompt text",
      },
    });
    returningMock.mockResolvedValue([
      { id: "sess-old", status: "scheduled", channelId: null },
    ]);

    const result = await materializeScheduledSession({
      ...base,
      subjectId: "ent-1",
      scheduledFor: SLOT_2,
    });

    // No second appointment.
    expect(instantiateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "rolled",
      missedCount: 1,
      session: { id: "sess-old" },
    });

    // Re-dated to the NEW slot (so the surface still says "do this now") and the
    // rest of the session's metadata survives the merge.
    const written = (setMock.mock.calls as unknown[][])[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(written.metadata[SCHEDULED_FOR_METADATA_KEY]).toBe(
      SLOT_2.toISOString()
    );
    expect(written.metadata[SCHEDULED_MISSED_COUNT_METADATA_KEY]).toBe(1);
    expect(written.metadata.keepMe).toBe("prompt text");
  });

  it("keeps counting misses across slots (the debt stays visible)", async () => {
    findFirstMock.mockResolvedValue({
      id: "sess-old",
      status: "scheduled",
      metadata: { [SCHEDULED_MISSED_COUNT_METADATA_KEY]: 3 },
    });
    returningMock.mockResolvedValue([
      { id: "sess-old", status: "scheduled", channelId: null },
    ]);

    const result = await materializeScheduledSession({
      ...base,
      scheduledFor: SLOT_2,
    });
    expect(result.missedCount).toBe(4);
  });

  it("an UNBOUND appointment matches its own predecessor via isNull, not eq(col, null)", async () => {
    // `eq(subjectEntityId, null)` compiles to `= NULL` — never true — so an
    // unbound appointment would never see itself and would mint a new row every
    // slot. This asserts the null branch reaches `isNull`.
    findFirstMock.mockResolvedValue(undefined);
    await materializeScheduledSession({
      ...base,
      subjectId: null,
      scheduledFor: SLOT_1,
    });
    expect(isNullMock).toHaveBeenCalledWith("col:subjectEntityId");
    expect(eqMock).not.toHaveBeenCalledWith("col:subjectEntityId", null);
  });

  it("a BOUND appointment matches on the subject (and never uses isNull for it)", async () => {
    await materializeScheduledSession({
      ...base,
      subjectId: "ent-9",
      scheduledFor: SLOT_1,
    });
    expect(eqMock).toHaveBeenCalledWith("col:subjectEntityId", "ent-9");
    expect(isNullMock).not.toHaveBeenCalled();
  });

  it("falls through and creates the next appointment when the human opened the old one mid-flight", async () => {
    // The guarded UPDATE re-asserts `status = 'scheduled'`; if the human started
    // the session between our read and our write it matches 0 rows. That row is
    // now in-progress WORK, not the calendar, so the correct answer is to
    // materialize the next appointment — not to do nothing.
    findFirstMock.mockResolvedValue({
      id: "sess-old",
      status: "scheduled",
      metadata: {},
    });
    returningMock.mockResolvedValue([]);

    const result = await materializeScheduledSession({
      ...base,
      scheduledFor: SLOT_2,
    });

    expect(result.outcome).toBe("created");
    expect(instantiateMock).toHaveBeenCalledTimes(1);
    expect(
      ((instantiateMock.mock.calls as unknown[][])[0][0] as { status?: string })
        .status
    ).toBe("scheduled");
  });
});

/**
 * Flattens the nested `and(...)` predicate the mocks record into the flat list
 * of `eq(col, value)` pairs it contains, so a test can assert a CLAUSE IS
 * PRESENT rather than that a helper was called somewhere. `expect(eqMock)
 * .toHaveBeenCalledWith(...)` would stay green if the clause were built and then
 * dropped from the `and`.
 */
const eqPairs = (node: unknown): Array<[unknown, unknown]> => {
  if (!node || typeof node !== "object") return [];
  const n = node as {
    op?: string;
    parts?: unknown[];
    c?: unknown;
    v?: unknown;
  };
  if (n.op === "and") return (n.parts ?? []).flatMap(eqPairs);
  if (n.op === "eq") return [[n.c, n.v]];
  return [];
};

describe("an appointment belongs to ONE calendar", () => {
  // A playbook can be pod-scoped and runnable from several workspaces, and
  // `focus_sessions` is per-user. An unscoped idempotency query would let
  // workspace B's tick find workspace A's appointment, roll A's calendar onto
  // B's slot and bump A's missedCount — while B never got a row of its own.
  it("scopes the predecessor lookup to the workspace AND the user", async () => {
    await materializeScheduledSession({ ...base, scheduledFor: SLOT_1 });

    const where = (findFirstMock.mock.calls[0][0] as { where: unknown }).where;
    expect(eqPairs(where)).toEqual(
      expect.arrayContaining([
        ["col:workspaceId", "ws-1"],
        ["col:userId", "user-1"],
      ])
    );
  });

  it("scopes the guarded roll-forward UPDATE to the same two keys", async () => {
    findFirstMock.mockResolvedValue({
      id: "sess-old",
      status: "scheduled",
      metadata: {},
    });
    returningMock.mockResolvedValue([{ id: "sess-old", status: "scheduled" }]);

    await materializeScheduledSession({ ...base, scheduledFor: SLOT_2 });

    expect(eqPairs(whereMock.mock.calls[0][0])).toEqual(
      expect.arrayContaining([
        ["col:workspaceId", "ws-1"],
        ["col:userId", "user-1"],
      ])
    );
  });
});

describe("provenance follows the SLOT, not the row", () => {
  it("re-stamps `scheduledBy` on roll-forward with THIS tick's run", async () => {
    // Left alone, `scheduledBy` keeps naming the automation run that minted the
    // appointment months ago while the date beside it is the one this tick just
    // wrote — the one field that answers "what put this here" answering for a
    // different occurrence than the row displays.
    findFirstMock.mockResolvedValue({
      id: "sess-old",
      status: "scheduled",
      metadata: {
        [SCHEDULED_FOR_METADATA_KEY]: SLOT_1.toISOString(),
        [SCHEDULED_MISSED_COUNT_METADATA_KEY]: 2,
        [SCHEDULED_BY_METADATA_KEY]: {
          playbookId: "pb-1",
          automationRunId: "run-JULY",
        },
      },
    });
    returningMock.mockResolvedValue([{ id: "sess-old", status: "scheduled" }]);

    await materializeScheduledSession({
      ...base,
      scheduledFor: SLOT_2,
      scheduledBy: { automationId: "auto-1", automationRunId: "run-NOW" },
    });

    const written = (
      setMock.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      }
    ).metadata;

    expect(written[SCHEDULED_BY_METADATA_KEY]).toEqual({
      playbookId: "pb-1",
      automationId: "auto-1",
      automationRunId: "run-NOW",
    });
    // …and the slot it is provenance FOR moved with it.
    expect(written[SCHEDULED_FOR_METADATA_KEY]).toBe(SLOT_2.toISOString());
    expect(written[SCHEDULED_MISSED_COUNT_METADATA_KEY]).toBe(3);
  });

  it("keeps the automation ids NESTED — flattening them would reclassify the row", async () => {
    // `session-kind.ts` reads `automationId`/`automationRunId` at the metadata
    // bag's TOP LEVEL and a non-null value at either makes the row a `run`.
    findFirstMock.mockResolvedValue({
      id: "sess-old",
      status: "scheduled",
      metadata: {},
    });
    returningMock.mockResolvedValue([{ id: "sess-old", status: "scheduled" }]);

    await materializeScheduledSession({
      ...base,
      scheduledFor: SLOT_2,
      scheduledBy: { automationId: "auto-1", automationRunId: "run-NOW" },
    });

    const written = (
      setMock.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      }
    ).metadata;
    expect(written.automationId).toBeUndefined();
    expect(written.automationRunId).toBeUndefined();
  });
});
