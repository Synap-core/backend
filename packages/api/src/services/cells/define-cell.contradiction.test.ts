/**
 * `contentKind` (the renderer SLOT) vs `viewTypes` (view-renderer AFFINITY) —
 * the write door REJECTS the contradictory pair instead of persisting it.
 *
 * THE DEFECT
 * ==========
 * `resolveCellContentKind` states the intent in prose ("a cell that declares
 * which view types it renders IS a collection renderer") but an explicit `raw`
 * WINS, so `{contentKind: "widget", viewTypes: ["table"]}` reached the row
 * intact — through EVERY door, since they all funnel into `defineCell`. The
 * runtime then registers the cell as a view renderer on `viewTypes.length > 0`
 * alone (`useRegisterFrameCells.ts`) while `renderersForType` filters on the
 * slot and never offers it: a pair no consumer can honour.
 *
 * REJECT, do not coerce. Forcing `contentKind = "collection"` would rewrite an
 * explicit choice silently, and a cell the author did not choose is worse than
 * an error.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  inserted: [] as unknown[],
  updatedRows: [] as unknown[],
  /** The row the post-write (merged-state) check finds. Empty ⇒ an INSERT. */
  storedRows: [] as Array<Record<string, unknown>>,
}));

// PARTIAL mock (`importOriginal`) — a total replacement dies at COLLECTION
// time the moment `define-cell.ts` starts using an export the object does not
// list, taking the whole file dark. See the
// `database-mock-total-ratchet` tripwire.
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
        from: () => ({ where: () => ({ limit: async () => h.storedRows }) }),
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
};

beforeEach(() => {
  h.inserted.length = 0;
  h.storedRows = [];
});

describe("defineCell — contentKind vs viewTypes", () => {
  it("REJECTS an explicit non-collection slot alongside a declared affinity", async () => {
    await expect(
      defineCell({ ...BASE, contentKind: "widget", viewTypes: ["table"] })
    ).rejects.toBeInstanceOf(CellDefinitionError);
    // …and nothing was written.
    expect(h.inserted).toHaveLength(0);
  });

  it("names BOTH fields in the error so the caller can act on it", async () => {
    let message = "";
    try {
      await defineCell({
        ...BASE,
        contentKind: "entity-detail",
        viewTypes: ["table", "list"],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("entity-detail");
    expect(message).toContain("table");
    expect(message).toContain("collection");
  });

  it("accepts contentKind=collection with an affinity — the coherent pair", async () => {
    await expect(
      defineCell({ ...BASE, contentKind: "collection", viewTypes: ["table"] })
    ).resolves.toMatchObject({ typeKey: "generated:my-cell" });
  });

  it("accepts an affinity with NO explicit slot — the derivation still applies", async () => {
    // Where `contentKind` is absent, `resolveCellContentKind`'s
    // viewTypes ⇒ collection inference is correct and untouched by this guard.
    await expect(
      defineCell({ ...BASE, viewTypes: ["table"] })
    ).resolves.toBeTruthy();
  });

  it("accepts a non-collection slot with NO affinity — a plain widget", async () => {
    await expect(
      defineCell({ ...BASE, contentKind: "widget" })
    ).resolves.toBeTruthy();
  });

  /**
   * THE BYPASS an input-only check cannot see. Both fields are omit-is-silence,
   * so the contradiction assembles across two individually-clean calls — which
   * is exactly the source-only re-push omit-is-silence exists to serve. The
   * invariant therefore has to hold on the POST-WRITE state `{stored ∪ input}`.
   */
  it("REJECTS a slot that contradicts the STORED affinity (assembled across calls)", async () => {
    h.storedRows = [{ contentKind: "collection", viewTypes: ["list"] }];
    await expect(
      // Call 2: states only contentKind. The stored `["list"]` survives
      // omit-is-silence, so the ROW would end up contradictory.
      defineCell({ ...BASE, contentKind: "widget" })
    ).rejects.toBeInstanceOf(CellDefinitionError);
    expect(h.inserted).toHaveLength(0);
  });

  it("REJECTS an affinity that contradicts the STORED slot (the mirror)", async () => {
    h.storedRows = [{ contentKind: "entity-detail", viewTypes: null }];
    await expect(
      defineCell({ ...BASE, viewTypes: ["table"] })
    ).rejects.toBeInstanceOf(CellDefinitionError);
  });

  it("ACCEPTS clearing the stored affinity in the same call as the slot", async () => {
    // The escape hatch the error message points at must actually work against a
    // stored list, not only against an empty row.
    h.storedRows = [{ contentKind: "collection", viewTypes: ["list"] }];
    await expect(
      defineCell({ ...BASE, contentKind: "widget", viewTypes: [] })
    ).resolves.toBeTruthy();
  });

  it("ACCEPTS a write that touches NEITHER field on a legacy contradictory row", async () => {
    // A source-only re-push (name/renderer only) must not be bricked by a
    // contradiction that predates this rule — the caller is not asserting it,
    // and refusing here would make such rows permanently un-editable.
    h.storedRows = [{ contentKind: "widget", viewTypes: ["list"] }];
    await expect(defineCell({ ...BASE })).resolves.toBeTruthy();
  });

  /**
   * The hole the post-write check OPENS if the insert is left alone.
   * `content_kind` is NOT NULL DEFAULT 'widget', so "unstated" is
   * unrepresentable: an insert carrying only `viewTypes` used to mint
   * `widget` + a non-empty affinity — the contradictory pair itself — and the
   * post-write check would then refuse every later edit to either field. The
   * door would mint a state it will not let anyone fix.
   */
  it("DERIVES collection on insert rather than minting the pair via the column default", async () => {
    h.storedRows = [];
    await defineCell({ ...BASE, viewTypes: ["table"] });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({ contentKind: "collection" });
  });

  it("does NOT derive a slot when no affinity is declared", async () => {
    h.storedRows = [];
    await defineCell({ ...BASE });
    expect(h.inserted[0]).not.toHaveProperty("contentKind");
  });

  it("an EXPLICIT slot still wins over the derivation", async () => {
    h.storedRows = [];
    await defineCell({ ...BASE, contentKind: "widget" });
    expect(h.inserted[0]).toMatchObject({ contentKind: "widget" });
  });

  it("accepts a non-collection slot with an EXPLICITLY CLEARED affinity", async () => {
    // `[]` is how a caller says "this is not a view renderer" — the escape
    // hatch the error message points at, so it must not itself be rejected.
    await expect(
      defineCell({ ...BASE, contentKind: "widget", viewTypes: [] })
    ).resolves.toBeTruthy();
  });
});
