/**
 * The ONE transition emitter: one log row + the `entity.transition` fan-out
 * (actor as `userId`, the producer the trigger hop reads), and — for a KIND
 * only — the back-compat `entity.update` fan-out with `changed.<slug>`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  appended: [] as unknown[],
  emitted: [] as any[],
}));
vi.mock("@synap/database", () => ({
  sql: {},
  EventRepository: class {
    async append(e: unknown) {
      h.appended.push(e);
      return { id: "ev1" };
    }
  },
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../side-effects.js", () => ({
  emitSideEffects: async (p: unknown) => {
    h.emitted.push(p);
  },
}));

import { emitLifecycleTransition } from "../lifecycle-transition.js";
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
      eventId: "ev1",
      data: { to: "negotiating", category: "active", role: null },
    });
    expect(h.emitted[1]).toMatchObject({
      action: "update",
      data: {
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
