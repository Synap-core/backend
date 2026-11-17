import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `X-Session-Id` is CLIENT-SUPPLIED. The whole point of this middleware is that
 * it is NOT trusted as-is: a header naming somebody else's focus session must
 * never become `ctx.sessionId`, or any caller could forge session attribution
 * onto another user's session.
 *
 * The DB is mocked at the `@synap/database` boundary so the ownership predicate
 * is exercised directly (`focus_sessions.id = ? AND userId = ?` → row or none).
 */

const rows: { id: string; userId: string }[] = [
  { id: "11111111-1111-4111-8111-111111111111", userId: "user-A" },
];

/** Captured `eq(column, value)` pairs so the WHERE can be evaluated in-memory. */
const eqCalls: { col: string; val: unknown }[] = [];
let shouldThrow = false;

vi.mock("@synap/database", async (importOriginal) => {
  // The real request write context underneath (`runWithNamedSession`,
  // `getNamedSessionId`); only the ownership read is stubbed.
  const actual = await importOriginal<typeof import("@synap/database")>();
  const col = (name: string) => ({ __col: name });
  return {
    ...actual,
    focusSessions: { id: col("id"), userId: col("userId") },
    eq: (c: { __col: string }, v: unknown) => {
      eqCalls.push({ col: c.__col, val: v });
      return { c, v };
    },
    and: (...parts: unknown[]) => parts,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (shouldThrow) throw new Error("db down");
              const id = eqCalls.find((e) => e.col === "id")?.val;
              const userId = eqCalls.find((e) => e.col === "userId")?.val;
              return rows.filter((r) => r.id === id && r.userId === userId);
            },
          }),
        }),
      }),
    },
  };
});

const { resolveHubSessionHeader, sessionMiddleware } = await import(
  "./session.js"
);
const { getNamedSessionId } = await import("@synap/database");

const OWNED = "11111111-1111-4111-8111-111111111111";
const OTHERS = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  eqCalls.length = 0;
  shouldThrow = false;
});

describe("hub X-Session-Id validation", () => {
  it("accepts a session the authenticated principal owns", async () => {
    expect(await resolveHubSessionHeader(OWNED, "user-A")).toBe(OWNED);
  });

  it("🔒 DROPS a session owned by someone else (forged attribution)", async () => {
    expect(await resolveHubSessionHeader(OWNED, "user-B")).toBeUndefined();
  });

  it("🔒 DROPS a session id that does not exist", async () => {
    expect(await resolveHubSessionHeader(OTHERS, "user-A")).toBeUndefined();
  });

  it("DROPS a non-uuid header without touching the DB", async () => {
    expect(
      await resolveHubSessionHeader("not-a-uuid", "user-A")
    ).toBeUndefined();
    expect(eqCalls).toEqual([]);
  });

  it("DROPS an empty / whitespace header without touching the DB", async () => {
    expect(await resolveHubSessionHeader("   ", "user-A")).toBeUndefined();
    expect(await resolveHubSessionHeader(undefined, "user-A")).toBeUndefined();
    expect(eqCalls).toEqual([]);
  });

  it("DROPS when there is no authenticated principal (skip-auth paths)", async () => {
    expect(await resolveHubSessionHeader(OWNED, undefined)).toBeUndefined();
    expect(eqCalls).toEqual([]);
  });

  it("fails CLOSED on a lookup error — an unverifiable handle is never promoted", async () => {
    shouldThrow = true;
    expect(await resolveHubSessionHeader(OWNED, "user-A")).toBeUndefined();
  });

  it("NEVER throws — a stale header must not break an unrelated write", async () => {
    // Every rejection path above returns rather than throwing; assert it
    // explicitly, since throwing would turn a lost grouping hint into an outage.
    shouldThrow = true;
    await expect(
      resolveHubSessionHeader(OWNED, "user-B")
    ).resolves.toBeUndefined();
    await expect(
      resolveHubSessionHeader("garbage", "user-A")
    ).resolves.toBeUndefined();
  });

  it("scopes the lookup by BOTH id and userId (no id-only match)", async () => {
    await resolveHubSessionHeader(OWNED, "user-A");
    expect(eqCalls.map((e) => e.col).sort()).toEqual(["id", "userId"]);
  });
});

// A2 (plan a640c5bb, 4bc6b9f4): the verified header is also the request's
// NAMED session, which the governance gate reads when a route passes none.
describe("hub X-Session-Id reaches the governance gate", () => {
  /** Runs the middleware; `next` reports the named session it runs under. */
  async function namedSessionSeenByRoute(
    header: string | undefined,
    userId: string | undefined
  ) {
    let seen: string | undefined | null = null;
    const set = vi.fn();
    const c = {
      req: { header: () => header },
      get: () => userId,
      set,
    } as unknown as Parameters<typeof sessionMiddleware>[0];
    await sessionMiddleware(c, async () => {
      seen = getNamedSessionId();
    });
    return { seen, set };
  }

  it("an owned header is the named session for the whole route", async () => {
    const { seen, set } = await namedSessionSeenByRoute(OWNED, "user-A");
    expect(seen).toBe(OWNED);
    expect(set).toHaveBeenCalledWith("sessionId", OWNED);
  });

  it("🔒 a header naming someone else's session names nothing", async () => {
    const { seen, set } = await namedSessionSeenByRoute(OWNED, "user-B");
    expect(seen).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
  });

  it("no header names nothing", async () => {
    const { seen } = await namedSessionSeenByRoute(undefined, "user-A");
    expect(seen).toBeUndefined();
  });

  it("the named session ends with the request", async () => {
    await namedSessionSeenByRoute(OWNED, "user-A");
    expect(getNamedSessionId()).toBeUndefined();
  });
});
