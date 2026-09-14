/**
 * R4 — an async-approved profile create is stamped from the APPROVED PROPOSAL
 * row's `agentUserId`, not from the event `data`.
 *
 * The job payload is built exactly as `setupEventBroadcasting` builds it from a
 * catch-all `.validated` event: the agent rides the event's `agent_user_id`
 * column, so `data` carries the gate fields + `sourceProposalId` and NO
 * `agentUserId`. Only the proposal lookup (the worker's authority read) and the
 * profile write edge are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  proposalRow: undefined as Record<string, unknown> | undefined,
  created: [] as Record<string, unknown>[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  class FakeProfileRepository {
    async create(input: Record<string, unknown>) {
      h.created.push(input);
      return { id: input.id };
    }
  }
  return {
    ...actual,
    getDb: async () => ({}),
    ProfileRepository: FakeProfileRepository,
    db: {
      ...(actual.db as object),
      query: {
        proposals: { findFirst: vi.fn(async () => h.proposalRow) },
        profiles: { findFirst: vi.fn(async () => undefined) },
      },
    },
  };
});

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn(async () => {}) }));

import { EventRepository } from "@synap/database";
import { handleMaterialize } from "../materializer.js";

vi.spyOn(EventRepository.prototype, "append").mockResolvedValue({} as never);

const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_ID = "55555555-5555-4555-8555-555555555555";

function profileCreateJob() {
  return {
    id: "job-1",
    name: "materialize",
    data: {
      eventId: "33333333-3333-4333-8333-333333333333",
      eventType: "profile.create.validated",
      subjectType: "profile",
      action: "create",
      subjectId: PROFILE_ID,
      userId: "approver-human",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      data: {
        id: PROFILE_ID,
        slug: "podcast",
        displayName: "Podcast",
        scope: "workspace",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        approvedBy: "approver-human",
        sourceProposalId: PROPOSAL_ID,
      },
    },
  } as never;
}

beforeEach(() => {
  h.created.length = 0;
});

describe("materializeProfile — origin from the approved proposal (R4)", () => {
  it("an agent-authored approved proposal is stamped 'agent' although data has no agentUserId", async () => {
    h.proposalRow = {
      id: PROPOSAL_ID,
      status: "approved",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      agentUserId: "agent-1",
    };
    await handleMaterialize(profileCreateJob());
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ id: PROFILE_ID, origin: "agent" });
  });

  it("a human-authored approved proposal is stamped 'authored'", async () => {
    h.proposalRow = {
      id: PROPOSAL_ID,
      status: "approved",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      agentUserId: null,
    };
    await handleMaterialize(profileCreateJob());
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ origin: "authored" });
  });
});
