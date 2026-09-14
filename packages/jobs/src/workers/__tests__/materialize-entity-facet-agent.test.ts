/**
 * R4 class, entity + facet — an async-approved entity create / facet attach
 * stamps provenance from the APPROVED PROPOSAL row's `agentUserId`, not from
 * the event `data`.
 *
 * The payload is shaped like the catch-all `.validated` emit: the agent rides
 * the event's `agent_user_id` column, so `data` carries the gate fields +
 * `sourceProposalId` and NO `agentUserId`. Only the proposal lookup and the
 * repository write edges are faked; the expected stamp comes from the REAL
 * `stampProvenance`, never hand-built.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  proposalRow: undefined as Record<string, unknown> | undefined,
  entityCreates: [] as Record<string, unknown>[],
  facetAttaches: [] as Record<string, unknown>[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  class FakeEntityRepository {
    async create(input: Record<string, unknown>) {
      h.entityCreates.push(input);
      return { id: input.id };
    }
  }
  class FakeFacetRepository {
    async attach(input: Record<string, unknown>) {
      h.facetAttaches.push(input);
      return { id: "facet-1" };
    }
  }
  return {
    ...actual,
    getDb: async () => ({}),
    EntityRepository: FakeEntityRepository,
    FacetRepository: FakeFacetRepository,
    db: {
      ...(actual.db as object),
      query: {
        proposals: { findFirst: vi.fn(async () => h.proposalRow) },
        entities: { findFirst: vi.fn(async () => undefined) },
      },
    },
  };
});

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn(async () => {}) }));

import { EventRepository, stampProvenance } from "@synap/database";
import { handleMaterialize } from "../materializer.js";

vi.spyOn(EventRepository.prototype, "append").mockResolvedValue({} as never);

const WS = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const ENTITY_ID = "55555555-5555-4555-8555-555555555555";
const APPROVER = "approver-human";

function job(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
) {
  return {
    id: "job-1",
    name: "materialize",
    data: {
      eventId: "33333333-3333-4333-8333-333333333333",
      eventType: `${subjectType}.${action}.validated`,
      subjectType,
      action,
      subjectId: ENTITY_ID,
      userId: APPROVER,
      workspaceId: WS,
      data: {
        ...data,
        workspaceId: WS,
        approvedBy: APPROVER,
        sourceProposalId: PROPOSAL_ID,
      },
    },
  } as never;
}

const entityJob = () =>
  job("entity", "create", { id: ENTITY_ID, profileSlug: "task", title: "T" });
const facetJob = () =>
  job("facet", "attach", { entityId: ENTITY_ID, profileSlug: "client" });

function approved(agentUserId: string | null) {
  h.proposalRow = {
    id: PROPOSAL_ID,
    status: "approved",
    workspaceId: WS,
    agentUserId,
  };
}

const expectedStamp = (agentUserId: string | undefined) =>
  stampProvenance({
    userId: APPROVER,
    agentUserId,
    sourceProposalId: PROPOSAL_ID,
  });

beforeEach(() => {
  h.entityCreates.length = 0;
  h.facetAttaches.length = 0;
});

describe("materializer provenance from the approved proposal (entity + facet)", () => {
  it("self-check: the real stamp discriminates agent from human", () => {
    expect(expectedStamp("agent-1")).not.toEqual(expectedStamp(undefined));
  });

  it("entity create: an agent-authored proposal stamps the agent although data has none", async () => {
    approved("agent-1");
    await handleMaterialize(entityJob());
    expect(h.entityCreates).toHaveLength(1);
    expect(h.entityCreates[0]).toMatchObject(expectedStamp("agent-1"));
  });

  it("entity create: a human-authored proposal stamps a human write", async () => {
    approved(null);
    await handleMaterialize(entityJob());
    expect(h.entityCreates[0]).toMatchObject(expectedStamp(undefined));
  });

  it("facet attach: an agent-authored proposal stamps the agent although data has none", async () => {
    approved("agent-1");
    await handleMaterialize(facetJob());
    expect(h.facetAttaches).toHaveLength(1);
    expect(h.facetAttaches[0]).toMatchObject(expectedStamp("agent-1"));
  });

  it("facet attach: a human-authored proposal stamps a human write", async () => {
    approved(null);
    await handleMaterialize(facetJob());
    expect(h.facetAttaches[0]).toMatchObject(expectedStamp(undefined));
  });
});
