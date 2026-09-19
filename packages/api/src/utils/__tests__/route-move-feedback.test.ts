/**
 * A human MOVE of an AI-placed entity is a CONFIRMATION when it lands on the
 * workspace the AI's route decision chose, and a correction otherwise.
 *
 * WHY THIS TEST EXISTS. Rung 5 proposes and never moves data, so the user
 * ACCEPTING an AI suggestion looks — at the move door — exactly like the user
 * overriding it: both are `entities.moveToWorkspace` on an entity carrying a
 * decision's correlationId. Reading them all as corrections told routing
 * memory the AI was wrong every time it was RIGHT, which is precisely the
 * metric the feature exists to produce.
 *
 * The seam under test is the JOIN: decision row (`data.chosenWorkspaceId`) ×
 * the move's destination. The db read and `auditLog` are the only two things
 * stubbed — the classification, the event subjectType and the `data` payload
 * are the real ones.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type AuditCall = {
  subjectType: string;
  action?: string;
  subjectId?: string;
  workspaceId?: string | null;
  data?: Record<string, unknown>;
};
const auditLog = vi.fn(async (_opts: AuditCall) => ({ id: "evt-1" }));
vi.mock("../audit-log.js", () => ({
  auditLog: (opts: AuditCall) => auditLog(opts),
}));

/** What the decision row's `chosenWorkspaceId` reads as for the next call. */
let chosen: string | null = null;
/** Set to throw from the decision lookup (an unreadable decision). */
let lookupThrows = false;

vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const rows = () => {
    if (lookupThrows) throw new Error("decision lookup down");
    return chosen === null ? [] : [{ chosen }];
  };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows()),
  };
  return { ...actual, db: { ...(actual.db as object), select: () => chain } };
});

const { emitRouteMoveFeedback } = await import("../ai-feedback-events.js");

const WS_AI = "11111111-1111-4111-8111-111111111111";
const WS_OTHER = "22222222-2222-4222-8222-222222222222";
const base = {
  userId: "user-1",
  entityId: "ent-1",
  fromWorkspaceId: WS_OTHER,
  correlationId: "corr-1",
};

const emittedSubjectTypes = () =>
  auditLog.mock.calls.map((c) => c[0].subjectType);

describe("emitRouteMoveFeedback", () => {
  beforeEach(() => {
    auditLog.mockClear();
    chosen = null;
    lookupThrows = false;
  });

  it("moving INTO the workspace the AI chose is a confirmation, not a correction", async () => {
    chosen = WS_AI;
    const verdict = await emitRouteMoveFeedback({
      ...base,
      toWorkspaceId: WS_AI,
    });
    expect(verdict).toBe("confirmation");
    expect(emittedSubjectTypes()).toEqual(["ai_confirmation"]);
    expect(auditLog.mock.calls[0]?.[0]).toMatchObject({
      action: "accept_suggestion",
      subjectId: "ent-1",
      workspaceId: WS_AI,
      data: {
        kind: "route",
        fromWorkspaceId: WS_OTHER,
        toWorkspaceId: WS_AI,
        // The DECISION's id is the join key and must ride inside `data`.
        correlationId: "corr-1",
      },
    });
  });

  it("moving ANYWHERE ELSE is still a correction", async () => {
    // The discriminating row: same entity, same decision, different destination.
    chosen = WS_AI;
    const verdict = await emitRouteMoveFeedback({
      ...base,
      fromWorkspaceId: WS_AI,
      toWorkspaceId: WS_OTHER,
    });
    expect(verdict).toBe("correction");
    expect(emittedSubjectTypes()).toEqual(["ai_correction"]);
  });

  it("no decision row under that id falls to the correction", async () => {
    chosen = null;
    expect(await emitRouteMoveFeedback({ ...base, toWorkspaceId: WS_AI })).toBe(
      "correction"
    );
    expect(emittedSubjectTypes()).toEqual(["ai_correction"]);
  });

  it("an UNREADABLE decision falls to the correction (the pre-existing behaviour), never throws", async () => {
    lookupThrows = true;
    expect(await emitRouteMoveFeedback({ ...base, toWorkspaceId: WS_AI })).toBe(
      "correction"
    );
    expect(emittedSubjectTypes()).toEqual(["ai_correction"]);
  });
});
