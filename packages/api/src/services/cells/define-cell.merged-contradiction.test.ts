/**
 * The contentKind/viewTypes contradiction, assembled ACROSS TWO CALLS.
 *
 * `define-cell.contradiction.test.ts` covers the single-call case. This covers
 * the one an input-only check cannot see, and which the omit-is-silence rule
 * makes reachable through every door:
 *
 *   call 1   viewTypes: ["list"]                    (no contentKind)  → ok
 *   call 2   contentKind: "widget"   (viewTypes omitted → stored list survives)
 *
 * Each call is individually clean. The ROW ends up with a non-collection slot
 * and a live affinity — the pair no consumer can honour, persisted anyway.
 *
 * The invariant therefore has to hold on the POST-WRITE state, {stored ∪ input},
 * not on the input alone. These pin that.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** What the stored row looks like to the merged-state select. */
  stored: null as {
    contentKind: string | null;
    viewTypes: string[] | null;
  } | null,
  inserted: [] as unknown[],
}));

// PARTIAL mock (`importOriginal`) — a total replacement dies at COLLECTION time
// the moment `define-cell.ts` uses an export the object does not list.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const insertChain = {
    values: (v: unknown) => {
      h.inserted.push(v);
      return {
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: "row-1" }],
        }),
      };
    },
  };
  return {
    ...actual,
    getDb: async () => ({
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (h.stored ? [h.stored] : []) }),
        }),
      }),
      insert: () => insertChain,
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      }),
    }),
  };
});

vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));

const { defineCell, CellDefinitionError } = await import("./define-cell.js");

const BASE = {
  name: "My Cell",
  rendererSource: "export default () => null",
  workspaceId: "ws-1",
  userId: "u-1",
  typeKey: "my-cell",
};

beforeEach(() => {
  h.stored = null;
  h.inserted.length = 0;
});

describe("defineCell — the contradiction assembled across calls", () => {
  it("REJECTS a non-collection slot when the STORED row already has an affinity", async () => {
    h.stored = { contentKind: null, viewTypes: ["list"] };
    await expect(
      defineCell({ ...BASE, contentKind: "widget" })
    ).rejects.toBeInstanceOf(CellDefinitionError);
  });

  it("names the STORED affinity in the error, not just the input", async () => {
    h.stored = { contentKind: null, viewTypes: ["list", "table"] };
    await expect(
      defineCell({ ...BASE, contentKind: "widget" })
    ).rejects.toThrow(/list, table/);
  });

  it("REJECTS a declared affinity when the STORED row is a non-collection slot", async () => {
    // The mirror: caller states viewTypes, the stored slot is the conflict.
    h.stored = { contentKind: "entity-detail", viewTypes: null };
    await expect(
      defineCell({ ...BASE, viewTypes: ["table"] })
    ).rejects.toBeInstanceOf(CellDefinitionError);
  });

  it("ACCEPTS clearing the affinity in the same call that sets the slot", async () => {
    // The documented escape hatch: `viewTypes: []` states both, coherently.
    h.stored = { contentKind: null, viewTypes: ["list"] };
    await expect(
      defineCell({ ...BASE, contentKind: "widget", viewTypes: [] })
    ).resolves.toBeDefined();
  });

  it("ACCEPTS a non-collection slot when the stored row has NO affinity", async () => {
    h.stored = { contentKind: null, viewTypes: [] };
    await expect(
      defineCell({ ...BASE, contentKind: "widget" })
    ).resolves.toBeDefined();
  });

  it("ACCEPTS a collection slot over a stored affinity — the coherent pair", async () => {
    h.stored = { contentKind: null, viewTypes: ["list"] };
    await expect(
      defineCell({ ...BASE, contentKind: "collection" })
    ).resolves.toBeDefined();
  });

  it("does not reject on a FRESH row — no stored state to contradict", async () => {
    h.stored = null;
    await expect(
      defineCell({ ...BASE, contentKind: "widget" })
    ).resolves.toBeDefined();
  });
});
