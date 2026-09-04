import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `attachSessionAgent` — the ONE append-only door onto `focus_sessions.agentIds`.
 *
 * Three properties, all of which the wholesale writers it replaces lack:
 * idempotency, an owner floor, and a row lock around the read-modify-write.
 *
 * DB-free: the transaction is mocked at the shape the door actually uses
 * (`select().from().where().for("update")` then `update().set().where()`), so
 * what these assert is the row the door would write.
 */

const { rows, sets, lockedWith, forMode, updateWhereCalls } = vi.hoisted(
  () => ({
    rows: { current: [] as unknown[] },
    sets: [] as Record<string, unknown>[],
    lockedWith: [] as unknown[],
    forMode: [] as string[],
    updateWhereCalls: { count: 0 },
  })
);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tx = {
    select: () => {
      const b: Record<string, unknown> = {
        from: () => b,
        where: (cond: unknown) => {
          lockedWith.push(cond);
          return b;
        },
        for: (mode: string) => {
          forMode.push(mode);
          return Promise.resolve(rows.current);
        },
      };
      return b;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        sets.push(patch);
        return {
          where: () => {
            updateWhereCalls.count += 1;
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  };
  return {
    ...actual,
    db: {
      transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    },
  };
});

import { attachSessionAgent } from "../attach-session-agent.js";

/** Every string leaf in a (circular) drizzle SQL object graph. */
function boundStrings(node: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    for (const child of Object.values(v as Record<string, unknown>))
      walk(child);
  };
  walk(node);
  return out;
}

const SESSION = "11111111-1111-1111-1111-111111111111";

describe("attachSessionAgent", () => {
  beforeEach(() => {
    sets.length = 0;
    lockedWith.length = 0;
    forMode.length = 0;
    updateWhereCalls.count = 0;
    rows.current = [];
  });

  it("appends an agent that is not yet on the roster", async () => {
    rows.current = [{ agentIds: ["agent-1"] }];

    const result = await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-2",
      userId: "user-a",
    });

    expect(result).toEqual({
      status: "attached",
      agentIds: ["agent-1", "agent-2"],
      added: true,
    });
    expect(sets).toHaveLength(1);
    expect(sets[0]!.agentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("seeds an empty roster", async () => {
    rows.current = [{ agentIds: [] }];

    const result = await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-1",
      userId: "user-a",
    });

    expect(result).toMatchObject({ agentIds: ["agent-1"], added: true });
  });

  it("tolerates a NULL column (the default is `[]`, but rows predate it)", async () => {
    rows.current = [{ agentIds: null }];

    const result = await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-1",
      userId: "user-a",
    });

    expect(result).toMatchObject({ agentIds: ["agent-1"], added: true });
  });

  it("IS IDEMPOTENT — re-attaching writes nothing and is not an error", async () => {
    rows.current = [{ agentIds: ["agent-1", "agent-2"] }];

    const result = await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-2",
      userId: "user-a",
    });

    expect(result).toEqual({
      status: "attached",
      agentIds: ["agent-1", "agent-2"],
      added: false,
    });
    // The point of idempotency: no duplicate, and no write at all.
    expect(sets).toHaveLength(0);
    expect(updateWhereCalls.count).toBe(0);
  });

  it("REFUSES a session that is not the caller's — indistinguishable from missing", async () => {
    // The owner floor lives in the load predicate, so an unowned session simply
    // does not come back.
    rows.current = [];

    const result = await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-2",
      userId: "someone-else",
    });

    expect(result).toEqual({ status: "not_found" });
    expect(sets).toHaveLength(0);
  });

  it("floors the load on BOTH the session id and the owner", async () => {
    rows.current = [{ agentIds: [] }];

    await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-1",
      userId: "user-a",
    });

    // The predicate is a real drizzle `and(eq(id), eq(userId))`. Its SQL object
    // graph is circular (a column points back at its table), so collect the
    // BOUND STRING VALUES instead of stringifying it — dropping the owner half
    // then reads red rather than becoming a silent cross-user write.
    expect(boundStrings(lockedWith[0])).toEqual(
      expect.arrayContaining([SESSION, "user-a"])
    );
  });

  it("takes the row lock — the RMW cannot lose a concurrent attach", async () => {
    rows.current = [{ agentIds: [] }];

    await attachSessionAgent({
      sessionId: SESSION,
      agentId: "agent-1",
      userId: "user-a",
    });

    expect(forMode).toEqual(["update"]);
  });

  it("rejects an empty agent id rather than writing a blank roster entry", async () => {
    rows.current = [{ agentIds: [] }];

    const result = await attachSessionAgent({
      sessionId: SESSION,
      agentId: "   ",
      userId: "user-a",
    });

    expect(result).toEqual({ status: "not_found" });
    expect(sets).toHaveLength(0);
  });
});
