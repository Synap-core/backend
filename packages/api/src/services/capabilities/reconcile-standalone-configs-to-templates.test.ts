/**
 * Tests for `reconcileStandaloneConfigsToTemplates` — the standalone-config
 * (view / skill / automation) counterpart to the capability reconcile.
 *
 * The load-bearing property under test is the FIELD-LEVEL 3-WAY MERGE
 * (`threeWayMergeFields`, run for REAL here — never mocked): an untouched field
 * advances to the template's new value, while a field the user edited since
 * install is OWNER-OWNED — left alone and reported, never overwritten. A source
 * package missing from the catalog cache is skipped, not errored.
 *
 * The db, the catalog lookup, and the governed router are mocked; the merge and
 * the source-link codecs (`readMarketSource`) run for real. Assertions check the
 * ACTUAL update payload handed to the governed door (that the merge LANDED — the
 * new value AND the advanced baseline), so the pass is never vacuous.
 *
 * The `view` kind is exercised because its governed `.update` door threads
 * `metadata` (as does `automation`); `skill` shares the identical engine path
 * but its router `.update` does not yet accept `metadata` (see the NOTE in the
 * engine), so its baseline persistence is a separate router concern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Row {
  [key: string]: unknown;
}

// `vi.mock` factories run during module-graph resolution, BEFORE this file's own
// top-level statements — so every value a factory closes over must come from
// `vi.hoisted`. Table identity is compared against the schema module's exports,
// resolved lazily via a dynamic `import()` (imports haven't run when the hoisted
// callback executes). Mirrors reconcile-capabilities-to-templates.test.ts.
const { state, dbMock, lookupCatalogEntry, viewUpdate } = vi.hoisted(() => {
  const state: {
    viewRows: Row[];
    updateCalls: Row[];
  } = {
    viewRows: [],
    updateCalls: [],
  };

  let schema: { views: unknown; skills: unknown; automations: unknown } | null =
    null;
  async function getSchema() {
    if (!schema) {
      schema = (await import("@synap/database/schema")) as never;
    }
    return schema!;
  }

  function resolveSelect(
    table: unknown,
    s: { views: unknown; skills: unknown; automations: unknown }
  ): Row[] {
    if (table === s.views) return state.viewRows;
    return []; // skills / automations tables are empty in these tests
  }

  const dbMock = {
    select(_cols?: unknown) {
      const chain: {
        _table?: unknown;
        from: (table: unknown) => typeof chain;
        where: (cond: unknown) => Promise<Row[]>;
        then: (
          resolve: (rows: Row[]) => unknown,
          reject: (err: unknown) => unknown
        ) => Promise<unknown>;
      } = {
        from(table: unknown) {
          chain._table = table;
          return chain;
        },
        where(_cond: unknown) {
          return getSchema().then((s) => resolveSelect(chain._table, s));
        },
        then(resolve, reject) {
          return getSchema()
            .then((s) => resolveSelect(chain._table, s))
            .then(resolve, reject);
        },
      };
      return chain;
    },
  };

  const viewUpdate = vi.fn(async (input: Row) => {
    state.updateCalls.push(input);
    return {}; // views.update returns the row (no `status`) → engine reads "updated"
  });

  return { state, dbMock, lookupCatalogEntry: vi.fn(), viewUpdate };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbMock };
});

vi.mock("./marketplace-install.js", () => ({
  lookupCatalogEntry: (...args: unknown[]) => lookupCatalogEntry(...args),
}));

vi.mock("../../routers/views.js", () => ({
  viewsRouter: {
    createCaller: () => ({ update: (input: Row) => viewUpdate(input) }),
  },
}));

const marketSource = (baseline: Record<string, unknown>) => ({
  packageSlug: "task-views",
  packageVersion: "1.0.0",
  installedAt: "2026-01-01T00:00:00.000Z",
  baseline,
});

describe("reconcileStandaloneConfigsToTemplates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.viewRows = [];
    state.updateCalls.length = 0;
  });

  it("advances an UNTOUCHED field to the template's new value (merge lands)", async () => {
    // Live config still equals the baseline (untouched since install) → the
    // template's new value must be applied.
    state.viewRows = [
      {
        id: "v1",
        name: "Board",
        userId: "u1",
        workspaceId: "w1",
        config: { color: "blue" },
        metadata: { marketSource: marketSource({ config: { color: "blue" } }) },
      },
    ];
    lookupCatalogEntry.mockResolvedValue({
      source: "https://cp.example",
      version: "1.1.0",
      definition: { views: [{ name: "Board", config: { color: "red" } }] },
    });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(report.updated).toHaveLength(1);
    expect(report.ownerOwnedSkipped).toHaveLength(0);
    // The governed door was called ONCE with the merged new value…
    expect(viewUpdate).toHaveBeenCalledTimes(1);
    const call = state.updateCalls[0]!;
    expect(call.id).toBe("v1");
    expect(call.config).toEqual({ color: "red" });
    // …and the baseline was ADVANCED so a future pass sees the row as untouched.
    expect(
      (call.metadata as { marketSource: { baseline: { config: unknown } } })
        .marketSource.baseline.config
    ).toEqual({ color: "red" });
  });

  it("leaves a USER-EDITED field alone (owner-owned) and reports it", async () => {
    // Live config diverges from the baseline → the user edited it → the template
    // must NOT overwrite it.
    state.viewRows = [
      {
        id: "v2",
        name: "Board",
        userId: "u1",
        workspaceId: "w1",
        config: { color: "green" }, // user-edited
        metadata: { marketSource: marketSource({ config: { color: "blue" } }) },
      },
    ];
    lookupCatalogEntry.mockResolvedValue({
      source: "https://cp.example",
      version: "1.1.0",
      definition: { views: [{ name: "Board", config: { color: "red" } }] },
    });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(viewUpdate).not.toHaveBeenCalled();
    expect(report.updated).toHaveLength(0);
    expect(report.ownerOwnedSkipped).toHaveLength(1);
    expect(report.ownerOwnedSkipped[0]!.reason).toContain("config");
  });

  it("skips a config whose source package is missing from the catalog cache", async () => {
    state.viewRows = [
      {
        id: "v3",
        name: "Board",
        userId: "u1",
        workspaceId: "w1",
        config: { color: "blue" },
        metadata: { marketSource: marketSource({ config: { color: "blue" } }) },
      },
    ];
    lookupCatalogEntry.mockResolvedValue(null); // cache MISS (private/unsynced)

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(viewUpdate).not.toHaveBeenCalled();
    expect(report.conflicts).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toContain("not in the catalog cache");
  });

  it("returns an empty report for an explicit empty `ids` (reconcile NOTHING)", async () => {
    state.viewRows = [
      {
        id: "v4",
        name: "Board",
        userId: "u1",
        workspaceId: "w1",
        config: { color: "blue" },
        metadata: { marketSource: marketSource({ config: { color: "blue" } }) },
      },
    ];

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({ ids: [] });

    expect(report.checked).toBe(0);
    expect(lookupCatalogEntry).not.toHaveBeenCalled();
    expect(viewUpdate).not.toHaveBeenCalled();
  });
});
