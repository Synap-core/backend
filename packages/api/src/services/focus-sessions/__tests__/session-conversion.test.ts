import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `revertConversion` — the undo half of session→playbook/project conversion.
 *
 * The archive write, the lineage-edge delete, and the goal restore are meant
 * to be ONE transaction (see the header comment in `session-conversion.ts`):
 * a half-revert is worse than one that fails outright and can be retried.
 *
 * DB-free (`database-mock-total` pattern): `db` is mocked at the shape the
 * function actually uses. `db.transaction` is modeled with real commit/
 * rollback semantics AT THE MOCK LAYER — writes made inside the callback are
 * staged and only applied to the in-memory `store` if the callback resolves;
 * if it throws, staged writes are discarded and the store is untouched. This
 * proves the function routes every write through `tx` (never the top-level
 * `db`) and stops on the first failure — it does NOT exercise Postgres's own
 * rollback, which no unit test in this repo's mock-DB style does.
 */

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const PLAYBOOK_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

const store = vi.hoisted(() => ({
  playbookStatus: "draft" as string,
  linkDeleted: false,
  sessionGoal: "Ship the thing",
  sessionMetadata: null as unknown,
}));

/** Calls actually routed through `tx` inside the transaction callback. */
const txCalls = vi.hoisted(() => [] as string[]);
/** Calls that would have gone straight to the top-level `db` (should be 0 for writes). */
const dbWriteCalls = vi.hoisted(() => [] as string[]);
/** When set, the write at this 1-based tx-call index throws instead of staging. */
const failAtCall = vi.hoisted(() => ({ index: -1 }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();

  const session = () => ({
    id: SESSION_ID,
    userId: USER_ID,
    goal: store.sessionGoal,
    workspaceId: "ws-1",
    projectId: null,
    subjectEntityId: null,
    metadata: store.sessionMetadata ?? {
      conversion: {
        kind: "playbook",
        id: PLAYBOOK_ID,
        name: "My Playbook",
        renamedFrom: "Ship the thing",
        at: new Date().toISOString(),
        by: USER_ID,
      },
    },
  });

  function makeTx() {
    /** Writes staged during this transaction attempt; applied only on success. */
    const pending: (() => void)[] = [];
    return {
      // READS run on the transaction too (`safeRevert` checks each target
      // `FOR UPDATE` inside it). Not recorded in `txCalls` — this suite pins
      // where the WRITES go. Counts answer 0; a locked row read answers the
      // store's current row.
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Object.assign(Promise.resolve([{ n: 0 }]), {
              for: () =>
                Promise.resolve(
                  table === actual.playbooks
                    ? [{ id: PLAYBOOK_ID, status: store.playbookStatus }]
                    : [{ status: "active" }]
                ),
            }),
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            txCalls.push(
              table === actual.playbooks
                ? "update:playbooks"
                : "update:focusSessions"
            );
            if (failAtCall.index === txCalls.length) {
              throw new Error("simulated write failure");
            }
            if (table === actual.playbooks) {
              pending.push(() => {
                store.playbookStatus = patch.status as string;
              });
            } else {
              pending.push(() => {
                store.sessionGoal = patch.goal as string;
                store.sessionMetadata = patch.metadata;
              });
            }
            return Promise.resolve();
          },
        }),
      }),
      delete: (_table: unknown) => ({
        where: () => {
          txCalls.push("delete:links");
          if (failAtCall.index === txCalls.length) {
            throw new Error("simulated write failure");
          }
          pending.push(() => {
            store.linkDeleted = true;
          });
          return Promise.resolve();
        },
      }),
      __commit: () => pending.forEach((apply) => apply()),
    };
  }

  return {
    ...actual,
    db: {
      query: {
        focusSessions: { findFirst: vi.fn(async () => session()) },
        playbooks: {
          findFirst: vi.fn(async () => ({
            id: PLAYBOOK_ID,
            status: store.playbookStatus,
          })),
        },
      },
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ n: 0 }]),
        }),
      }),
      update: (table: unknown) => {
        dbWriteCalls.push(
          table === actual.playbooks ? "db.update:playbooks" : "db.update:other"
        );
        return { set: () => ({ where: () => Promise.resolve() }) };
      },
      delete: () => {
        dbWriteCalls.push("db.delete");
        return { where: () => Promise.resolve() };
      },
      transaction: vi.fn(
        async (cb: (tx: ReturnType<typeof makeTx>) => unknown) => {
          const tx = makeTx();
          try {
            const result = await cb(tx);
            tx.__commit();
            return result;
          } catch (e) {
            // Rollback: staged writes are simply never applied.
            throw e;
          }
        }
      ),
    },
  };
});

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: vi.fn(async () => undefined),
}));

import { revertConversion } from "../session-conversion.js";

describe("revertConversion — transaction", () => {
  beforeEach(() => {
    store.playbookStatus = "draft";
    store.linkDeleted = false;
    store.sessionGoal = "Ship the thing";
    store.sessionMetadata = null;
    txCalls.length = 0;
    dbWriteCalls.length = 0;
    failAtCall.index = -1;
  });

  it("routes all three writes through the SAME transaction, never the top-level db", async () => {
    const { db } = await import("@synap/database");
    const result = await revertConversion({
      sessionId: SESSION_ID,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txCalls).toEqual([
      "update:playbooks",
      "delete:links",
      "update:focusSessions",
    ]);
    // No write escaped the transaction onto the raw `db` handle.
    expect(dbWriteCalls.filter((c) => c.startsWith("db."))).toEqual([]);
    expect(store.playbookStatus).toBe("archived");
    expect(store.linkDeleted).toBe(true);
    expect(store.sessionGoal).toBe("Ship the thing");
  });

  it("rolls back: a failure on the LAST write leaves the earlier writes unapplied", async () => {
    // Fail on the 3rd tx call (the focusSessions goal-restore update) — the
    // mock's commit-on-success/never-apply-on-throw model means the playbook
    // archive and the link delete staged before it must not have taken effect.
    failAtCall.index = 3;

    await expect(
      revertConversion({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow("simulated write failure");

    expect(store.playbookStatus).toBe("draft");
    expect(store.linkDeleted).toBe(false);
    expect(store.sessionGoal).toBe("Ship the thing");
  });

  it("rolls back: a failure on the FIRST write means later steps never even ran", async () => {
    failAtCall.index = 1;

    await expect(
      revertConversion({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow("simulated write failure");

    expect(txCalls).toEqual(["update:playbooks"]);
    expect(store.playbookStatus).toBe("draft");
    expect(store.linkDeleted).toBe(false);
  });
});
