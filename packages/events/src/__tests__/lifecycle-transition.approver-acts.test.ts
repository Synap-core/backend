/**
 * THE APPROVER ACTS (founder, 17 Nov 2026, « Lead → client in the product »
 * W1b). When a person approves an agent's proposed move, what the move sets
 * off runs as the person who approved it; the agent stays the proposer.
 *
 * Driven through the REAL emitter and the REAL reactors (only the pg-boss
 * transport and the log repository are stubbed), so what is checked is the
 * `automation-trigger-match` job itself: its `userId` (the matcher's floor,
 * and the run's `triggeredBy`, which the executor's steps run as) and its
 * `producerAgentUserId` (the confused-deputy guard's producer).
 *
 *  - an APPROVED agent move: both name the approver; the log row still names
 *    the agent (`agentUserId`, `isAgent`) and the payload keeps both;
 *  - a DIRECT agent move (no approval): both name the agent, as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LifecycleTransitionPayload } from "@synap-core/types/lifecycle";

const h = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => "job-id"),
  appended: [] as Array<Record<string, unknown>>,
}));

vi.mock("../boss.js", () => ({ getBoss: () => ({ send: h.send }) }));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: { server: { vectorSearchEnabled: false } },
}));
vi.mock("@synap/database", () => ({
  isUniqueViolation: () => false,
  db: {},
  claimTransitionOutbox: vi.fn(),
  settleTransitionOutbox: vi.fn(),
  listDueTransitions: async () => [],
  eventRepository: {
    async append(e: Record<string, unknown>) {
      h.appended.push(e);
      return { id: e.id };
    },
  },
}));

const { emitLifecycleTransition } = await import("../lifecycle-transition.js");

const PERSON = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const PROPOSAL = "66666666-6666-4666-8666-666666666666";

/** « Win a deal »'s Won stage moves the lead's role to converted. */
const leadConverted = (
  over: Partial<LifecycleTransitionPayload> = {}
): LifecycleTransitionPayload => ({
  transitionId: "77777777-7777-4777-8777-777777777777",
  subjectType: "entity",
  subjectId: "e-lead",
  entityId: "e-lead",
  profileSlug: "person",
  role: "lead",
  facetId: "f-lead",
  property: "leadStage",
  from: "qualified",
  to: "converted",
  fromCategory: "active",
  category: "done",
  actorKind: "agent",
  actorClass: "agent",
  appId: null,
  userId: PERSON,
  agentUserId: AGENT,
  sessionId: null,
  reason: null,
  staleExpected: false,
  proposalId: null,
  workspaceId: "ws-crm",
  occurredAt: "2026-11-17T10:00:00.000Z",
  recordedAt: "2026-11-17T10:00:00.000Z",
  backdated: false,
  hold: null,
  ...over,
});

const matcherJobs = () =>
  h.send.mock.calls
    .filter((c) => c[0] === "automation-trigger-match")
    .map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  h.send.mockClear();
  h.appended = [];
});

describe("an approved agent move acts as the person who approved it", () => {
  it("the trigger hop runs as the approver; the agent stays the proposer on the log row", async () => {
    const r = await emitLifecycleTransition(
      leadConverted({ proposalId: PROPOSAL, approvedBy: PERSON })
    );
    expect(r.complete).toBe(true);

    const jobs = matcherJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      eventType: "entity.transition.completed",
      userId: PERSON,
      // A person decided it: no agent is the producer of what it sets off.
      producerAgentUserId: PERSON,
      // The automation-visible payload keeps both.
      data: { agentUserId: AGENT, approvedBy: PERSON, to: "converted" },
    });

    // « Who did this »: the log row still names the agent and its proposal.
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      type: "entity.transition.completed",
      agentUserId: AGENT,
      isAgent: true,
      proposalId: PROPOSAL,
    });
  });

  it("an agent's direct move (no approval) still acts as the agent", async () => {
    await emitLifecycleTransition(leadConverted());

    const jobs = matcherJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      userId: AGENT,
      producerAgentUserId: AGENT,
    });
  });
});
