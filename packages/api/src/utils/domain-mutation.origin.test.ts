/**
 * `origin: "sync"` must reach the side-effect fan-out, or the matcher can never
 * skip a bulk sync write. Two ways in:
 *   1. explicit `recordDomainMutation({ origin: "sync" })` (the sync door);
 *   2. DERIVED from `proposalId` — an entity materialized by approving a
 *      connection's import.graph names that proposal, and the proposal carries
 *      `data.connectionSync`. This is how the approval path gets origin without
 *      the approval code knowing about sync.
 * The derivation runs INSIDE the fire-and-forget fan-out: the caller never waits
 * on the proposal read.
 * Seam test: drives the public door and asserts the value arrives at
 * `emitSideEffects`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  emitted: [] as Record<string, unknown>[],
  lookups: [] as string[],
  syncProposals: new Set<string>(),
  failLookup: false,
  failNext: 0,
  /** When set, every lookup waits on this promise (a slow DB read). */
  gate: null as Promise<void> | null,
}));

vi.mock("./audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "event-1" })),
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
    isConnectionSyncProposal: vi.fn(async (proposalId: string) => {
      h.lookups.push(proposalId);
      if (h.gate) await h.gate;
      if (h.failLookup) throw new Error("db down");
      if (h.failNext > 0) {
        h.failNext -= 1;
        throw new Error("db blip");
      }
      return h.syncProposals.has(proposalId);
    }),
  };
});

const { recordDomainMutation, __resetSyncProposalMemo } =
  await import("./domain-mutation.js");

const SYNC_PROP = "11111111-1111-4111-8111-111111111111";
const PLAIN_PROP = "22222222-2222-4222-8222-222222222222";

const BASE = {
  subjectType: "entity",
  action: "create",
  subjectId: "aaaaaaaa-1111-4111-8111-111111111111",
  userId: "user-1",
  workspaceId: "ws-1",
  data: { profileSlug: "person" },
};

/** Let the fire-and-forget fan-out chain settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.emitted.length = 0;
  h.lookups.length = 0;
  h.syncProposals = new Set([SYNC_PROP]);
  h.failLookup = false;
  h.failNext = 0;
  h.gate = null;
  __resetSyncProposalMemo();
});

describe("recordDomainMutation → SideEffectPayload.origin", () => {
  it("forwards an explicit origin 'sync' to the fan-out", async () => {
    await recordDomainMutation({ ...BASE, origin: "sync" });
    await flush();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.origin).toBe("sync");
    expect(h.lookups).toHaveLength(0);
  });

  it("an ordinary mutation emits no origin and does no lookup", async () => {
    await recordDomainMutation({ ...BASE });
    await flush();
    expect("origin" in h.emitted[0]!).toBe(false);
    expect(h.lookups).toHaveLength(0);
  });

  it("DERIVES origin 'sync' for a write materialized from a connection-sync proposal", async () => {
    await recordDomainMutation({ ...BASE, proposalId: SYNC_PROP });
    await flush();
    expect(h.emitted[0]?.origin).toBe("sync");
  });

  it("a RELATION write naming a connection-sync proposal is tagged 'sync' too", async () => {
    await recordDomainMutation({
      subjectType: "relation",
      action: "create",
      subjectId: "bbbbbbbb-1111-4111-8111-111111111111",
      userId: "user-1",
      workspaceId: "ws-1",
      proposalId: SYNC_PROP,
      data: { relationType: "works_at", fromEntityId: "a", toEntityId: "b" },
    });
    await flush();
    expect(h.emitted[0]?.origin).toBe("sync");
  });

  it("a write from an ordinary proposal carries no origin", async () => {
    await recordDomainMutation({ ...BASE, proposalId: PLAIN_PROP });
    await flush();
    expect("origin" in h.emitted[0]!).toBe(false);
  });

  it("approving a 200-entity import reads the proposal ONCE", async () => {
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        recordDomainMutation({
          ...BASE,
          subjectId: `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`,
          proposalId: SYNC_PROP,
        })
      )
    );
    await flush();
    expect(h.emitted).toHaveLength(200);
    expect(h.emitted.every((e) => e.origin === "sync")).toBe(true);
    expect(h.lookups).toHaveLength(1);
  });

  it("the CALLER does not wait on the proposal read; the fan-out still carries origin", async () => {
    let release!: () => void;
    h.gate = new Promise<void>((r) => {
      release = r;
    });

    const record = await recordDomainMutation({
      ...BASE,
      proposalId: SYNC_PROP,
    });
    // The mutation returned while the lookup is still blocked…
    expect(record).toMatchObject({ id: "event-1" });
    expect(h.lookups).toHaveLength(1);
    await flush();
    // …and nothing has been fanned out without its origin in the meantime.
    expect(h.emitted).toHaveLength(0);

    release();
    await flush();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.origin).toBe("sync");
  });

  it("a TRANSIENT lookup failure is retried once within the same mutation and still tags 'sync'", async () => {
    h.failNext = 1;
    await recordDomainMutation({ ...BASE, proposalId: SYNC_PROP });
    await flush();
    expect(h.emitted[0]?.origin).toBe("sync");
    expect(h.lookups).toHaveLength(2); // fail, then a fresh (evicted) read
  });

  it("a PERSISTENT lookup failure does not fail the mutation, emits without origin after one retry, and is retried next time", async () => {
    h.failLookup = true;
    await expect(
      recordDomainMutation({ ...BASE, proposalId: SYNC_PROP })
    ).resolves.toMatchObject({ id: "event-1" });
    await flush();
    expect("origin" in h.emitted[0]!).toBe(false);
    expect(h.lookups).toHaveLength(2);

    h.failLookup = false;
    await recordDomainMutation({ ...BASE, proposalId: SYNC_PROP });
    await flush();
    expect(h.emitted[1]?.origin).toBe("sync");
    expect(h.lookups).toHaveLength(3);
  });
});
