/**
 * The two session doors that are the PERSON's act refuse an agent key:
 * `acceptFromTriage` (accepting a draft starts its held run, B6) and `grade`
 * (the owner's verdict; the attest it discharges accepts a draft on
 * engagement). An agent key reads as its person, so the owner floor alone
 * would let an agent accept or grade its own draft.
 *
 * Reachability, measured 2026-10-21: the `/trpc` mount needs a Kratos session
 * and never sets `agentUserId`; `hubProtocolRouter` has no `focusSessions`; no
 * internal caller forwards `agentUserId` to `focusSessionsRouter`. These
 * refusals are the floor for the day one of those changes.
 *
 * Driven through the real tRPC procedures; the services behind them are
 * stubbed and observed (a refused call must never reach them).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  graded: [] as unknown[],
  accepted: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      // The tRPC read-only guard seeds `syncGeneration` on every call.
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
      query: new Proxy({} as Record<string, unknown>, {
        get: () => ({ findFirst: async () => undefined }),
      }),
    },
  };
});
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../services/focus-sessions/evaluations/evaluate.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  gradeCriterionAsOwner: vi.fn(async (p: unknown) => {
    h.graded.push(p);
    return {
      out: { status: "recorded", evaluation: { id: "ev-1" } },
      resumed: false,
    };
  }),
}));
vi.mock("../services/focus-sessions/triage.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acceptFromTriage: vi.fn(async (p: unknown) => {
    h.accepted.push(p);
    return { ok: false, reason: "not_pending" };
  }),
}));

const { focusSessionsRouter } = await import("./focus-sessions.js");

const person = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    authenticated: true,
  } as never);
const agentKey = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    agentUserId: "22222222-2222-4222-8222-222222222222",
    authenticated: true,
  } as never);

const GRADE = {
  sessionId: SESSION,
  criterionKey: "ships",
  verdict: "pass" as const,
};

describe("person-only session doors", () => {
  beforeEach(() => {
    h.graded = [];
    h.accepted = [];
  });

  it("grade: an agent key is refused before the grade door runs", async () => {
    await expect(agentKey().grade(GRADE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.graded).toHaveLength(0);
  });

  it("grade: the person reaches the grade door (control)", async () => {
    await person().grade(GRADE);
    expect(h.graded).toHaveLength(1);
  });

  it("acceptFromTriage: an agent key is refused before the accept runs", async () => {
    await expect(
      agentKey().acceptFromTriage({ sessionId: SESSION })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.accepted).toHaveLength(0);
  });

  it("acceptFromTriage: the person reaches the accept (control)", async () => {
    await person().acceptFromTriage({ sessionId: SESSION });
    expect(h.accepted).toHaveLength(1);
  });
});
