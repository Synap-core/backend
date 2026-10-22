/**
 * The ONE transition emitter: one log row + the `entity.transition` fan-out
 * (actor as `userId`, the producer the trigger hop reads), and — for a KIND
 * only — the back-compat `entity.update` fan-out with `changed.<slug>`.
 * Delivery (D8): a failed attempt reports what is still owed, and the retry
 * skips what was delivered; the log row is never appended twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  appended: [] as unknown[],
  emitted: [] as any[],
  /** Reactor ids that fail on their next call (then succeed). */
  failOnce: new Set<string>(),
  appendError: null as unknown,
  settled: [] as any[],
  claim: vi.fn(),
}));
vi.mock("@synap/database", async () => ({
  // The real door, so a wrapped unique violation is recognised as in prod.
  isUniqueViolation: (
    await vi.importActual<typeof import("@synap/database/pg-errors")>(
      "@synap/database/pg-errors"
    )
  ).isUniqueViolation,
  sql: {},
  db: {},
  claimTransitionOutbox: h.claim,
  settleTransitionOutbox: async (_db: unknown, id: string, r: unknown) => {
    h.settled.push({ id, ...(r as object) });
  },
  listDueTransitions: async () => [],
  EventRepository: class {
    async append(e: { id: string }) {
      if (h.appendError) throw h.appendError;
      h.appended.push(e);
      return { id: e.id };
    }
  },
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
// Two reactors per fan-out, so a retry can be seen skipping the delivered one.
vi.mock("../side-effects.js", () => ({
  fanOutSideEffects: async (p: any, skip: ReadonlySet<string>) => {
    const delivered: string[] = [];
    const failed: string[] = [];
    for (const id of ["automation", "webhook"]) {
      if (skip.has(id)) continue;
      const key = `${p.action}:${id}`;
      if (h.failOnce.delete(key)) {
        failed.push(id);
        continue;
      }
      if (id === "automation") h.emitted.push(p);
      delivered.push(id);
    }
    return { delivered, failed, queueDown: false };
  },
}));

import {
  dispatchLifecycleTransition,
  emitLifecycleTransition,
} from "../lifecycle-transition.js";
import {
  playbookActivatorSentence,
  toBackendTrigger,
} from "@synap-core/types/automations";
import { evaluateTriggerFilterValue } from "@synap-core/types/automations/filter-operators";

/** The matcher's rule: every filter key evaluates true against the payload. */
function firesOn(
  data: Record<string, unknown>,
  profileSlug: string,
  to: string
) {
  const s = playbookActivatorSentence({
    playbookId: "pb",
    profileSlug,
    on: "enters_status",
    statusProperty: "commercialStage",
    status: to,
    lifecycle: "declared",
    mode: "run",
  });
  const t = toBackendTrigger(s.trigger!, s.conditions);
  const filters = t.triggerConfig.filters as Record<string, unknown>;
  return Object.entries(filters).every(([k, v]) =>
    evaluateTriggerFilterValue(data[k], v)
  );
}

const T = {
  transitionId: "t1",
  entityId: "e1",
  profileSlug: "deal",
  role: null as string | null,
  facetId: null,
  property: "commercialStage",
  from: "draft",
  to: "negotiating",
  fromCategory: "open",
  category: "active",
  actorKind: "agent" as const,
  userId: "u1",
  agentUserId: "a1",
  sessionId: null,
  reason: null,
  staleExpected: false,
  proposalId: null,
  workspaceId: "w1",
};

beforeEach(() => {
  h.appended = [];
  h.emitted = [];
  h.failOnce.clear();
  h.appendError = null;
  h.settled = [];
  h.claim.mockReset();
});

describe("emitLifecycleTransition", () => {
  it("kind: one log row, the transition fan-out, and the back-compat update fan-out", async () => {
    await emitLifecycleTransition(T);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      type: "entity.transition.completed",
    });
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[0]).toMatchObject({
      action: "transition",
      userId: "a1",
      // The log row's id IS the transition's: at most one row, ever.
      eventId: "t1",
      data: { to: "negotiating", category: "active", role: null },
    });
    expect(h.emitted[1]).toMatchObject({
      action: "update",
      data: {
        transitionId: "t1",
        "changed.commercialStage": true,
        "previous.commercialStage": "draft",
        commercialStage: "negotiating",
      },
    });
  });

  it("role: no back-compat update fan-out", async () => {
    await emitLifecycleTransition({ ...T, role: "lead", agentUserId: null });
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({ action: "transition", userId: "u1" });
  });

  // SEAM (E1): the payload this emits is the one a compiled enters_status
  // rule filters — driven through the real compiler and the real evaluator.
  it("an enters_status rule fires on its OWN subject's move — kind or role — and no other", async () => {
    await emitLifecycleTransition(T);
    const kindMove = h.emitted[0].data;
    expect(kindMove.lifecycleProfile).toBe("deal");
    expect(firesOn(kindMove, "deal", "negotiating")).toBe(true);
    expect(firesOn(kindMove, "deal", "won")).toBe(false);

    h.emitted = [];
    await emitLifecycleTransition({ ...T, role: "client" });
    const roleMove = h.emitted[0].data;
    expect(roleMove.lifecycleProfile).toBe("client");
    expect(firesOn(roleMove, "client", "negotiating")).toBe(true);
    // A role's move on a deal is NOT the deal's own move.
    expect(firesOn(roleMove, "deal", "negotiating")).toBe(false);
  });
});

describe("dispatchLifecycleTransition — the owed event is delivered once", () => {
  const owed = (progress: { eventId: string | null; delivered: string[] }) => ({
    transition: T,
    emitContext: { correlationId: "c1" },
    attempts: 1,
    ...progress,
  });

  it("a failed reactor leaves the row owed; the retry sends only what is missing", async () => {
    h.failOnce.add("transition:webhook");
    h.claim.mockResolvedValueOnce(owed({ eventId: null, delivered: [] }));
    expect(await dispatchLifecycleTransition("t1")).toBe(false);
    expect(h.settled[0]).toMatchObject({
      id: "t1",
      complete: false,
      eventId: "t1",
      delivered: [
        "transition:automation",
        "update:automation",
        "update:webhook",
      ],
    });
    expect(h.appended).toHaveLength(1);
    expect(h.emitted).toHaveLength(2);

    // The sweeper's retry replays the stored progress.
    h.claim.mockResolvedValueOnce(
      owed({ eventId: h.settled[0].eventId, delivered: h.settled[0].delivered })
    );
    expect(await dispatchLifecycleTransition("t1")).toBe(true);
    expect(h.settled[1]).toMatchObject({ complete: true });
    expect(h.settled[1].delivered).toContain("transition:webhook");
    // Nothing delivered twice; the log row not appended again.
    expect(h.emitted).toHaveLength(2);
    expect(h.appended).toHaveLength(1);
  });

  it("a failed log append fans out nothing — history and triggers never disagree", async () => {
    h.appendError = new Error("events down");
    h.claim.mockResolvedValueOnce(owed({ eventId: null, delivered: [] }));
    expect(await dispatchLifecycleTransition("t1")).toBe(false);
    expect(h.emitted).toHaveLength(0);
    expect(h.settled[0]).toMatchObject({ complete: false, eventId: null });
    expect(h.settled[0].error).toMatch(/log append/);
  });

  it("a log row an earlier attempt wrote (unique violation) counts as written", async () => {
    h.appendError = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    h.claim.mockResolvedValueOnce(owed({ eventId: null, delivered: [] }));
    expect(await dispatchLifecycleTransition("t1")).toBe(true);
    expect(h.settled[0]).toMatchObject({ complete: true, eventId: "t1" });
  });

  it("a row already delivered or held by another dispatcher is left alone", async () => {
    h.claim.mockResolvedValueOnce(null);
    expect(await dispatchLifecycleTransition("t1")).toBe(false);
    expect(h.settled).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });
});
