import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * SUBJECT CONTINUITY across a chained process: "when a session CLOSES → run the
 * follow-up playbook on the SAME subject".
 *
 * The close event (`complete-session.ts`) publishes `subjectId` = the SESSION
 * and `data.subjectId` = the ENTITY the session was about. Two hops dropped it:
 *
 *  1. `deriveEventSubjectEntityId` read only `data.entityId` for non-entity
 *     events → the follow-up run row carried NO subject;
 *  2. the `playbook_run` step fell back to the raw `trigger.payload.subjectId`
 *     (the SESSION id) → the entity lookup missed and the binding was dropped
 *     with a warning.
 *
 * Driven as the chain runs: the run's subject is derived by the REAL derivation
 * from the close event's real payload shape, handed to the step the way the
 * executor builds `StepContext.trigger.subject` (`run.subjectEntityId`), and
 * the assertion is on what the playbook runner RECEIVES.
 */

const ENTITY = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  runnerMock: vi.fn(async () => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-followup", channelId: "chan-1" },
  })),
  entityFindFirstMock: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { entities: { findFirst: h.entityFindFirstMock } },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  // The where-clause is the id itself, so the mock below can answer by id.
  eq: (_col: unknown, value: unknown) => value,
  and: vi.fn(),
  drizzleSql: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  deriveProposalProjectId: vi.fn(),
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({ users: {} }));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../utils/realtime-broadcast.js", () => ({
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import { registerPlaybookRunner } from "../../capability-dispatch.js";
import { deriveEventSubjectEntityId } from "../../../utils/run-subject.js";
import type { StepContext } from "../../automation-executor-types.js";

beforeEach(() => {
  h.runnerMock.mockClear();
  h.entityFindFirstMock.mockReset();
  h.entityFindFirstMock.mockImplementation(async (q: { where: unknown }) =>
    q.where === ENTITY ? { id: ENTITY, workspaceId: "ws-1" } : undefined
  );
  registerPlaybookRunner(h.runnerMock as never);
});

/** The close event exactly as `complete-session.ts` publishes it. */
const closeEvent = {
  eventType: "focus_session.close.completed",
  subjectId: SESSION,
  data: { subjectId: ENTITY, playbookId: "pb-produce", verdict: "pass" },
};

describe("session close → follow-up keeps the subject", () => {
  it("derives the ENTITY (not the session) as the follow-up run's subject", () => {
    expect(deriveEventSubjectEntityId(closeEvent)).toBe(ENTITY);
    // …and a stage_changed event the same way (advance-stage.ts emit).
    expect(
      deriveEventSubjectEntityId({
        eventType: "focus_session.stage_changed.completed",
        subjectId: SESSION,
        data: { sessionId: SESSION, subjectId: ENTITY, toStage: "published" },
      })
    ).toBe(ENTITY);
    // A session with no subject yields none — never the session id.
    expect(
      deriveEventSubjectEntityId({
        ...closeEvent,
        data: { subjectId: null, playbookId: "pb" },
      })
    ).toBeUndefined();
  });

  it("the follow-up run binds that entity even though payload.subjectId is the session", async () => {
    const runSubject = deriveEventSubjectEntityId(closeEvent) ?? null;
    const context = {
      // What the matcher fires with (payload.subjectId = the session) and what
      // the executor surfaces from the run row (trigger.subject).
      // Payload shape = the matcher's `fireAutomation` trigger payload.
      trigger: {
        payload: {
          eventType: closeEvent.eventType,
          subjectId: SESSION,
          data: closeEvent.data,
        },
        subject: runSubject,
      },
      steps: {},
      automation: { id: "auto-1", state: {} },
    } as unknown as StepContext;

    await executePlaybookRun(
      { playbookId: "pb-repurpose" },
      context,
      "ws-1",
      "user-1"
    );

    expect(h.runnerMock).toHaveBeenCalledTimes(1);
    const input = (h.runnerMock.mock.calls as unknown[][])[0]![0] as {
      subjectId?: string;
      playbookId: string;
    };
    expect(input.playbookId).toBe("pb-repurpose");
    expect(input.subjectId).toBe(ENTITY);
  });
});
