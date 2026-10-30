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
 * `view` and `skill` are exercised; `automation` shares the identical engine
 * path. That the real `skills.update` door persists the metadata this engine
 * hands it is pinned on PGlite in
 * `reconcile-standalone-configs-to-templates.skill-metadata.pglite.test.ts`.
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
const { state, dbMock, lookupCatalogEntry, viewUpdate, skillUpdate } =
  vi.hoisted(() => {
    const state: {
      viewRows: Row[];
      skillRows: Row[];
      updateCalls: Row[];
    } = {
      viewRows: [],
      skillRows: [],
      updateCalls: [],
    };

    let schema: {
      views: unknown;
      skills: unknown;
      automations: unknown;
    } | null = null;
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
      if (table === s.skills) return state.skillRows;
      return []; // automations tables are empty in these tests
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

    const skillUpdate = vi.fn(async (input: Row) => {
      state.updateCalls.push(input);
      return {};
    });

    return {
      state,
      dbMock,
      lookupCatalogEntry: vi.fn(),
      viewUpdate,
      skillUpdate,
    };
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbMock };
});

vi.mock("./marketplace-install.js", () => ({
  lookupCatalogEntry: (...args: unknown[]) => lookupCatalogEntry(...args),
}));

vi.mock("../../routers/skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({ update: (input: Row) => skillUpdate(input) }),
  },
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
    state.skillRows = [];
    state.updateCalls.length = 0;
  });

  it("reads a skill package through its `skill` slot — the shape the catalog serves", async () => {
    // Founder pod 2026-10-13: creative-director read "content changed" then
    // "up to date (no drift)" on every run — the flat read saw no field at all.
    const baseline = { body: "old body", description: "old" };
    state.skillRows = [
      {
        id: "s1",
        name: "Creative director",
        userId: "u1",
        workspaceId: null,
        body: "old body",
        description: "old",
        metadata: {
          marketSource: {
            ...marketSource(baseline),
            packageSlug: "creative-director",
          },
        },
      },
    ];
    lookupCatalogEntry.mockResolvedValue({
      source: "https://cp.example",
      version: "h-new",
      definition: {
        _meta: { slug: "creative-director" },
        skill: {
          name: "Creative director",
          body: "new body",
          description: "new",
        },
      },
    });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(report.skipped).toHaveLength(0);
    expect(report.updated).toHaveLength(1);
    expect(skillUpdate).toHaveBeenCalledTimes(1);
    expect(state.updateCalls[0]).toMatchObject({
      id: "s1",
      body: "new body",
      description: "new",
    });
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
    // …and the version it converged to is stamped, so a list that compares
    // versions agrees with this pass.
    expect(
      (call.metadata as { marketSource: { packageVersion: string } })
        .marketSource.packageVersion
    ).toBe("1.1.0");
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

  // ── the list and the apply agree (founder pod, 2026-10-30) ──────────────────

  /** A skill row installed at `version` with `baseline`, live = `live`. */
  function skillRow(opts: {
    slug: string;
    version: string;
    baseline: Record<string, unknown>;
    live: Record<string, unknown>;
  }): Row {
    return {
      id: `skill-${opts.slug}`,
      name: opts.slug,
      userId: "u1",
      workspaceId: null,
      ...opts.live,
      metadata: {
        marketSource: {
          ...marketSource(opts.baseline),
          packageSlug: opts.slug,
          packageVersion: opts.version,
        },
      },
    };
  }

  function catalogSkill(version: string, fields: Record<string, unknown>) {
    lookupCatalogEntry.mockResolvedValue({
      source: "https://cp.example",
      version,
      definition: { skill: { name: "any", ...fields } },
    });
  }

  type Stamp = {
    packageVersion: string;
    comparatorVersion?: number;
    baseline: Record<string, unknown>;
  };
  const stampOf = (call: Row) =>
    (call.metadata as { marketSource: Stamp }).marketSource;

  it("a body the owner set to the catalog's is SAME, not owner-owned (facecam-edit)", async () => {
    state.skillRows = [
      skillRow({
        slug: "facecam-edit",
        version: "h-1",
        baseline: { body: "installed body" },
        live: { body: "catalog body" },
      }),
    ];
    catalogSkill("h-2", { body: "catalog body" });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(report.ownerOwnedSkipped).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toContain("up to date");
    // One metadata-only write: no field is rewritten, the baseline catches up
    // and the version is stamped.
    expect(skillUpdate).toHaveBeenCalledTimes(1);
    const call = state.updateCalls[0]!;
    expect(call).not.toHaveProperty("body");
    expect(stampOf(call).baseline).toEqual({ body: "catalog body" });
    expect(stampOf(call).packageVersion).toBe("h-2");
  });

  it("stamps the catalog version on a row already equal to it (video-toolbox)", async () => {
    // Every managed field already equals the catalog, only the version stamp
    // is old: the list said "content changed" and the apply "no drift", forever.
    state.skillRows = [
      skillRow({
        slug: "video-toolbox",
        version: "h-old",
        baseline: { body: "b", description: "d" },
        live: { body: "b", description: "d" },
      }),
    ];
    catalogSkill("h-7b0c46", { body: "b", description: "d" });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(skillUpdate).toHaveBeenCalledTimes(1);
    const stamp = stampOf(state.updateCalls[0]!);
    expect(stamp.packageVersion).toBe("h-7b0c46");
    expect(stamp.comparatorVersion).toBe(1);
    expect(report.skipped[0]!.reason).toContain("up to date");
    expect(report.skipped[0]!.reason).toContain("h-7b0c46");
  });

  it("a dry run reports the stamp it would write and writes nothing", async () => {
    state.skillRows = [
      skillRow({
        slug: "video-toolbox",
        version: "h-old",
        baseline: { body: "b" },
        live: { body: "b" },
      }),
    ];
    catalogSkill("h-7b0c46", { body: "b" });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({
      dryRun: true,
    });

    expect(skillUpdate).not.toHaveBeenCalled();
    expect(report.skipped[0]!.reason).toContain(
      "would record version h-7b0c46"
    );
  });

  it("writes nothing once the stamp and baseline are current", async () => {
    state.skillRows = [
      skillRow({
        slug: "video-toolbox",
        version: "h-7b0c46",
        baseline: { body: "b" },
        live: { body: "b" },
      }),
    ];
    catalogSkill("h-7b0c46", { body: "b" });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({});

    expect(skillUpdate).not.toHaveBeenCalled();
    expect(report.skipped[0]!.reason).toBe("up to date (no drift)");
  });

  it("says which kept fields the catalog changed too and which are yours only", async () => {
    state.skillRows = [
      skillRow({
        slug: "content-taste",
        version: "h-1",
        baseline: { body: "v1", description: "same upstream" },
        live: { body: "mine", description: "my words" },
      }),
    ];
    catalogSkill("h-2", { body: "v2", description: "same upstream" });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({
      dryRun: true,
    });

    expect(report.ownerOwnedSkipped).toHaveLength(1);
    const reason = report.ownerOwnedSkipped[0]!.reason;
    expect(reason).toContain(
      "conflicted (the catalog changed them too): [body]"
    );
    expect(reason).toContain("yours only: [description]");
  });

  it("an edit of yours alone still earns the stamp; a conflict keeps the old version", async () => {
    state.skillRows = [
      skillRow({
        slug: "designing-with-real-components",
        version: "h-1",
        baseline: { body: "v1", description: "upstream" },
        live: { body: "v1", description: "my words" },
      }),
    ];
    catalogSkill("h-2", { body: "v1", description: "upstream" });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    await reconcileStandaloneConfigsToTemplates({});

    expect(skillUpdate).toHaveBeenCalledTimes(1);
    const call = state.updateCalls[0]!;
    expect(call).not.toHaveProperty("description"); // the owner's words stay
    expect(stampOf(call).packageVersion).toBe("h-2");
    expect(stampOf(call).baseline).toEqual({
      body: "v1",
      description: "upstream",
    });

    // The same row once the catalog changes the owner's field too: conflicted,
    // nothing written, the version stays where it was.
    vi.clearAllMocks();
    state.updateCalls.length = 0;
    catalogSkill("h-3", { body: "v1", description: "upstream v3" });
    const report = await reconcileStandaloneConfigsToTemplates({});
    expect(skillUpdate).not.toHaveBeenCalled();
    expect(report.ownerOwnedSkipped[0]!.reason).toContain(
      "conflicted (the catalog changed them too): [description]"
    );
  });

  it("naming packages reconciles only the rows installed from them", async () => {
    state.viewRows = [
      {
        id: "v-named",
        name: "Board",
        userId: "u1",
        workspaceId: "w1",
        config: { color: "blue" },
        metadata: { marketSource: marketSource({ config: { color: "blue" } }) },
      },
      {
        id: "v-other",
        name: "Board",
        userId: "u1",
        workspaceId: "w1",
        config: { color: "blue" },
        metadata: {
          marketSource: {
            ...marketSource({ config: { color: "blue" } }),
            packageSlug: "other-views",
          },
        },
      },
    ];
    lookupCatalogEntry.mockResolvedValue({
      source: "https://cp.example",
      version: "1.1.0",
      definition: { views: [{ name: "Board", config: { color: "red" } }] },
    });

    const { reconcileStandaloneConfigsToTemplates } =
      await import("./reconcile-standalone-configs-to-templates.js");
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["task-views"],
    });

    expect(report.checked).toBe(1);
    expect(lookupCatalogEntry).toHaveBeenCalledTimes(1);
    expect(lookupCatalogEntry).toHaveBeenCalledWith("view", "task-views");
    expect(viewUpdate).toHaveBeenCalledTimes(1);
    expect(state.updateCalls[0]!.id).toBe("v-named");

    vi.clearAllMocks();
    const none = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: [],
    });
    expect(none.checked).toBe(0);
    expect(lookupCatalogEntry).not.toHaveBeenCalled();
  });
});
