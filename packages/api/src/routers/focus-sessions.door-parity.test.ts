/**
 * `focusSessions` tRPC — DOOR PARITY with the MCP and Hub start/close doors.
 *
 * The screens can only show what the door returns. Three blocks the service
 * already produced never crossed this boundary, so the browser could not say
 * which template ran, whether the session it got back was adopted rather than
 * created, or how the close graded against the session's criteria:
 *
 *   - `create` dropped `template` (SessionTemplateReport) and `adopted`.
 *   - `close` returned the bare row — no `warnings`, no `verdict`.
 *
 * These drive the REAL procedures and read what the caller receives, so the
 * claim is "the value arrives", not "the key is declared". The deduped arm is
 * asserted too, for the opposite property: a reused session must NOT claim a
 * template report, because no matching ran.
 *
 * DB-FREE: the two services are mocked at their module boundary (this file
 * tests the DOOR's projection, not the services, which own their own tests);
 * `@synap/database`'s connection is replaced.
 */

import { describe, it, expect, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";

const createSpy = vi.fn();
const completeSpy = vi.fn();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      // Enough of a chain for the middleware that runs before every procedure
      // (the split-brain read-only guard seeds a row); nothing under test
      // reads it back.
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

vi.mock("../services/focus-sessions/create-session.js", () => ({
  createFocusSession: createSpy,
}));

vi.mock("../services/focus-sessions/complete-session.js", () => ({
  completeFocusSession: completeSpy,
}));

const { focusSessionsRouter } = await import("./focus-sessions.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);

const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  userId: "user-1",
  workspaceId: WS,
  goal: "Ship the thing",
  status: "active",
  expectedOutputs: [],
  ...over,
});

/** The exact block the MCP/Hub start doors already return. */
const TEMPLATE = {
  applied: {
    id: "pb-1",
    name: "Weekly review",
    confidence: 0.82,
    decider: "jev" as const,
  },
  suggestions: [
    { id: "pb-2", name: "Retro", score: 0.4, reason: "You mentioned “review”" },
  ],
  optOut: "templateId: null",
};

describe("focusSessions.create — the template report reaches the caller", () => {
  it("carries `template` and `adopted` off a created session", async () => {
    createSpy.mockResolvedValue({
      status: "created",
      session: sessionRow(),
      template: TEMPLATE,
      adopted: true,
    });

    const out = await caller().create({ workspaceId: WS, goal: "Review" });

    // The VALUE arrives, not merely a declared key: the applied playbook's
    // name and decider are what the room's "template applied" row renders.
    expect(out).toMatchObject({
      id: SESSION,
      adopted: true,
      template: {
        applied: { id: "pb-1", name: "Weekly review", decider: "jev" },
        suggestions: [{ id: "pb-2", name: "Retro" }],
      },
    });
  });

  it("carries the HONEST no-match reason, so 'unavailable' never reads as a decision", async () => {
    createSpy.mockResolvedValue({
      status: "created",
      session: sessionRow(),
      template: {
        applied: null,
        suggestions: [],
        notApplied: "unavailable",
        optOut: "templateId: null",
      },
    });

    const out = await caller().create({ workspaceId: WS, goal: "Review" });
    expect(out).toMatchObject({
      template: { applied: null, notApplied: "unavailable" },
    });
    // Nothing was adopted, so the flag stays OFF — an absent `adopted` and a
    // `false` one must not be spelled the same way as `true`.
    expect(out).not.toHaveProperty("adopted");
  });

  it("a DEDUPED session claims no template — nothing was created, so nothing matched", async () => {
    createSpy.mockResolvedValue({
      status: "deduped",
      session: sessionRow(),
      candidates: [],
    });

    const out = await caller().create({ workspaceId: WS, goal: "Review" });
    expect(out).toMatchObject({ id: SESSION, deduped: true });
    expect(out).not.toHaveProperty("template");
    expect(out).not.toHaveProperty("adopted");
  });
});

describe("focusSessions.close — the verdict and the warnings reach the caller", () => {
  it("returns the criteria verdict alongside the row", async () => {
    completeSpy.mockResolvedValue({
      session: sessionRow({ status: "closed" }),
      pendingProposals: [],
      counts: {
        pending: 0,
        unfinishedOutputs: 1,
        expiredEphemerals: 0,
        retiredSlots: 0,
      },
      warnings: [
        "1 required criterion not met — session closed anyway, flagged.",
      ],
      verdict: {
        total: 2,
        passed: 1,
        failed: 1,
        unmeasured: 0,
        requiredUnmet: 1,
        state: "failing",
      },
    });

    const out = await caller().close({ id: SESSION });

    expect(out).toMatchObject({
      id: SESSION,
      status: "closed",
      verdict: { requiredUnmet: 1, failed: 1, state: "failing" },
    });
    // The close's own sentence — the browser re-derived this client-side from
    // the PRE-close scorecard because the door never handed it over.
    expect(out.warnings).toEqual([
      "1 required criterion not met — session closed anyway, flagged.",
    ]);
  });

  it("omits `verdict` when the session declared no criteria (never 'unknown')", async () => {
    completeSpy.mockResolvedValue({
      session: sessionRow({ status: "closed" }),
      pendingProposals: [],
      counts: {
        pending: 0,
        unfinishedOutputs: 0,
        expiredEphemerals: 0,
        retiredSlots: 0,
      },
      warnings: [],
    });

    const out = await caller().close({ id: SESSION });
    expect(out).not.toHaveProperty("verdict");
    expect(out.warnings).toEqual([]);
  });
});
