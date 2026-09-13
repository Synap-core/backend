/**
 * `emitFacetSideEffects` fans out directly (not through `recordDomainMutation`),
 * so it resolves origin itself: a facet written while approving a
 * connection-sync import (it names that proposal) must carry `origin: "sync"` on
 * BOTH of its emits — the facet event and the parent-entity refresh — or every
 * facet automation fires once per imported record. Driven through the real
 * helper; only the emit and the proposal lookup are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  emitted: [] as Record<string, unknown>[],
  syncProposals: new Set<string>(),
}));

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/events")>();
  return {
    ...actual,
    emitSideEffects: vi.fn(async (payload: Record<string, unknown>) => {
      h.emitted.push(payload);
    }),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    isConnectionSyncProposal: vi.fn(async (proposalId: string) =>
      h.syncProposals.has(proposalId)
    ),
  };
});

const { emitFacetSideEffects } = await import("./helpers.js");
const { __resetSyncProposalMemo } =
  await import("../../utils/domain-mutation.js");

const SYNC_PROP = "11111111-1111-4111-8111-111111111111";

const BASE = {
  action: "attach" as const,
  entityId: "ent-1",
  facetId: "facet-1",
  profileSlug: "client",
  userId: "user-1",
  workspaceId: "ws-1",
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.emitted.length = 0;
  h.syncProposals = new Set([SYNC_PROP]);
  __resetSyncProposalMemo();
});

describe("emitFacetSideEffects → origin", () => {
  it("a facet written under a connection-sync proposal tags BOTH emits 'sync'", async () => {
    emitFacetSideEffects({ ...BASE, proposalId: SYNC_PROP });
    await flush();
    expect(h.emitted.map((e) => e.subjectType)).toEqual([
      "entity_facet",
      "entity",
    ]);
    expect(h.emitted.every((e) => e.origin === "sync")).toBe(true);
  });

  it("an explicit origin is honoured without a proposal", async () => {
    emitFacetSideEffects({ ...BASE, origin: "sync" });
    await flush();
    expect(h.emitted.every((e) => e.origin === "sync")).toBe(true);
  });

  it("an ordinary facet write carries no origin", async () => {
    emitFacetSideEffects({ ...BASE });
    await flush();
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted.some((e) => "origin" in e)).toBe(false);
  });
});
