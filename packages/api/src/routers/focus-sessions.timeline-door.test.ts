/**
 * `focusSessions.timeline` — the tRPC door of THE timeline read
 * (`services/timeline/read-timeline.ts`), the same read behind Hub
 * `GET /timeline` and MCP `synap_get_timeline`.
 *
 * Driven through the REAL procedure with the REAL subject parser
 * (`timelineSubjectOf`); only `readTimeline` is replaced at its module
 * boundary (it owns its own pglite test). Asserted: the value the caller
 * receives is the read's own, the reader is the caller (never a client-named
 * user), a subject that is not the caller's is NOT_FOUND (never an empty
 * timeline), and a bad subject is refused before any read.
 */

import { describe, expect, it, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const readSpy = vi.fn();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      insert: () => {
        const chain: Record<string, unknown> = {
          values: () => chain,
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
      select: () => {
        const chain: Record<string, unknown> = {
          from: () => chain,
          where: () => chain,
          limit: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
      query: new Proxy({} as Record<string, unknown>, {
        get: () => ({ findFirst: async () => undefined }),
      }),
    },
  };
});

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

vi.mock("../services/timeline/read-timeline.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readTimeline: readSpy };
});

const { focusSessionsRouter } = await import("./focus-sessions.js");

const caller = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    authenticated: true,
  } as never);

const WIRE = {
  subject: { kind: "session", id: SESSION, title: "Ship the thing" },
  events: [
    {
      id: "transition:1",
      kind: "status_moved",
      at: "2026-11-16T10:00:00.000Z",
      actor: { kind: "system", id: null, name: null },
      refs: { sessionId: SESSION },
      from: "active",
      to: "paused",
      category: "paused",
      reason: null,
      hold: null,
    },
  ],
  truncated: false,
};

describe("focusSessions.timeline", () => {
  it("returns the timeline read for the caller", async () => {
    readSpy.mockReset().mockResolvedValue(WIRE);
    const out = await caller().timeline({ sessionId: SESSION });
    expect(out).toEqual(WIRE);
    expect(readSpy).toHaveBeenCalledWith(
      { kind: "session", id: SESSION },
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it("is NOT_FOUND when the subject is not the caller's, never an empty timeline", async () => {
    readSpy.mockReset().mockResolvedValue(null);
    await expect(
      caller().timeline({ sessionId: SESSION })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a request naming no subject, or two, before any read", async () => {
    readSpy.mockReset();
    await expect(caller().timeline({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller().timeline({ sessionId: SESSION, pr: "o/r#1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(readSpy).not.toHaveBeenCalled();
  });
});
