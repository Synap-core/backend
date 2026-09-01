/**
 * Tests for the capability-container membership self-heal in
 * `reconcileCapabilitiesToTemplates`.
 *
 * BUG: `capability-containers.addPart` carries a pod-scope authorization floor
 * (container's own `createdBy` or a pod admin, for a `workspaceId: null`
 * container). `create-from-definition.ts`'s `attachPart` calls it but SWALLOWS
 * a rejection (non-fatal — counted as `partsNotAttached`, never thrown). So a
 * non-owning teammate applying a template update that introduces a NEW tool to
 * an ALREADY-EXISTING pod-scoped container leaves that tool row created but
 * with NO `member_of` edge — and `capabilityDefinitionDrift` only diffs
 * SKILLS, so the orphan was invisible to reconcile entirely.
 *
 * Two layers of test:
 *  1. `missingToolMemberships` — the pure diff function (no DB).
 *  2. `reconcileCapabilitiesToTemplates` end-to-end with a mocked db + mocked
 *     collaborators — proves the missing-membership case actually drives a
 *     re-apply through the SAME governed `createCapabilityFromDefinition`
 *     door (never a raw `links` insert), and that a container with complete
 *     membership is a true no-op (idempotent).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { missingToolMemberships } from "./reconcile-capabilities-to-templates.js";

// ── missingToolMemberships (pure) ────────────────────────────────────────────

describe("missingToolMemberships", () => {
  it("reports no missing tools when every declared tool is a member", () => {
    expect(
      missingToolMemberships(
        [{ name: "toolA" }, { name: "toolB" }],
        new Set(["toolA", "toolB"])
      )
    ).toEqual([]);
  });

  it("reports a declared tool with no member_of edge", () => {
    expect(
      missingToolMemberships(
        [{ name: "toolA" }, { name: "toolB" }],
        new Set(["toolA"])
      )
    ).toEqual(["toolB"]);
  });

  it("skips a tool name carrying an unresolved {{param}} placeholder", () => {
    // Same convention as capabilityDefinitionDrift's skill-name skip: a live
    // row's name was interpolated at install time, so it can never be matched
    // by exact template name here — reporting it "missing" would be a false
    // positive that could mint a junk re-apply.
    expect(
      missingToolMemberships([{ name: "{{provider}}_search" }], new Set())
    ).toEqual([]);
  });

  it("is a true no-op (empty) when there are no declared tools", () => {
    expect(missingToolMemberships([], new Set(["toolA"]))).toEqual([]);
  });
});

// ── reconcileCapabilitiesToTemplates (mocked db + collaborators) ────────────

interface Row {
  [key: string]: unknown;
}

// `vi.mock` factories run during module-graph resolution, BEFORE the test
// file's own top-level statements execute (imports always resolve before a
// module's body runs) — so every value a factory closes over, AND every
// value needed to build that value, must come from `vi.hoisted`, which runs
// ahead of even the file's own imports. Table identity is compared against
// the schema module's exports, imported here too — `vi.hoisted`'s callback
// can't reference an import binding directly (imports haven't run yet at that
// point), so it imports the schema module itself via a dynamic `import()`.
const {
  state,
  dbMock,
  loadCapabilityTemplate,
  createCapabilityFromDefinition,
} = vi.hoisted(() => {
  const state: {
    containersRows: Row[];
    memberSkillLinkRows: Row[];
    installedSkillRows: Row[];
    memberToolRows: Row[];
    updateCalls: Array<{ table: unknown; set: unknown }>;
  } = {
    containersRows: [],
    memberSkillLinkRows: [],
    installedSkillRows: [],
    memberToolRows: [],
    updateCalls: [],
  };

  // Lazily resolved (only read the first time a query actually runs, well
  // after the schema module has loaded) so this dodges the same hoisting
  // constraint that forced `dbMock` itself in here.
  let schema: {
    capabilities: unknown;
    skills: unknown;
    tools: unknown;
    links: unknown;
  } | null = null;
  async function getSchema() {
    if (!schema) {
      schema = (await import("@synap/database/schema")) as never;
    }
    return schema!;
  }

  function resolveSelect(
    table: unknown,
    joined: unknown,
    s: {
      capabilities: unknown;
      skills: unknown;
      tools: unknown;
      links: unknown;
    }
  ): Row[] {
    if (table === s.capabilities) return state.containersRows;
    if (table === s.links && joined === s.tools) return state.memberToolRows;
    if (table === s.links && !joined) return state.memberSkillLinkRows;
    if (table === s.skills) return state.installedSkillRows;
    return [];
  }

  const dbMock = {
    select(_cols?: unknown) {
      const chain: {
        _table?: unknown;
        _joined?: unknown;
        from: (table: unknown) => typeof chain;
        innerJoin: (table: unknown) => typeof chain;
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
        innerJoin(table: unknown) {
          chain._joined = table;
          return chain;
        },
        where(_cond: unknown) {
          return getSchema().then((s) =>
            resolveSelect(chain._table, chain._joined, s)
          );
        },
        then(resolve, reject) {
          return getSchema()
            .then((s) => resolveSelect(chain._table, chain._joined, s))
            .then(resolve, reject);
        },
      };
      return chain;
    },
    update(table: unknown) {
      return {
        set(setObj: unknown) {
          return {
            where(_cond: unknown) {
              state.updateCalls.push({ table, set: setObj });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return {
    state,
    dbMock,
    loadCapabilityTemplate: vi.fn(),
    createCapabilityFromDefinition: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbMock };
});

import { DRIFT_COMPARATOR_VERSION } from "./capability-drift.js";

vi.mock("./catalog-cache-query.js", () => ({
  queryCatalogCache: vi.fn().mockResolvedValue([]),
}));

// PARTIAL mock: the two DB-touching doors are stubbed, but `deriveToolVerbs` /
// `GRANT_DEFAULT_EXEC_MODE` are the REAL pure projection the verb-catalog drift
// check diffs against — stubbing them would compare the reconcile to a fiction.
// (A total `() => ({...})` factory here also silently broke the moment the
// reconcile imported anything new from this module.)
vi.mock("./create-from-definition.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./create-from-definition.js")>();
  return {
    ...actual,
    loadCapabilityTemplate: (...args: unknown[]) =>
      loadCapabilityTemplate(...args),
    createCapabilityFromDefinition: (...args: unknown[]) =>
      createCapabilityFromDefinition(...args),
  };
});

describe("reconcileCapabilitiesToTemplates — tool membership self-heal", () => {
  const container: Row = {
    id: "container-1",
    name: "Test Capability",
    createdBy: "user-1",
    workspaceId: null,
    metadata: { templateKey: "tmpl-key", contentHash: "old-hash" },
  };

  const templateDef = {
    key: "tmpl-key",
    name: "Test Capability",
    updatePolicy: "auto" as const,
    contentHash: "new-hash", // differs from stored → bypasses the fast path
    tools: [{ name: "toolA" }],
    skills: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.containersRows = [container];
    state.memberSkillLinkRows = [];
    state.installedSkillRows = [];
    state.memberToolRows = [];
    state.updateCalls.length = 0;
    loadCapabilityTemplate.mockResolvedValue(templateDef);
    createCapabilityFromDefinition.mockResolvedValue(undefined);
  });

  it("repairs a tool that exists with no member_of edge — re-applies through createCapabilityFromDefinition", async () => {
    // toolA is declared by the template but NOT in the member_of graph — the
    // exact shape `attachPart`'s swallowed authorization rejection leaves
    // behind.
    state.memberToolRows = [];

    const { reconcileCapabilitiesToTemplates } =
      await import("./reconcile-capabilities-to-templates.js");
    const report = await reconcileCapabilitiesToTemplates({});

    expect(createCapabilityFromDefinition).toHaveBeenCalledTimes(1);
    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]!.reason).toContain(
      "missingToolMembership=[toolA]"
    );
    expect(report.conflicts).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
  });

  it("is a no-op when every declared tool already has a member_of edge (idempotent)", async () => {
    state.memberToolRows = [{ name: "toolA" }];

    const { reconcileCapabilitiesToTemplates } =
      await import("./reconcile-capabilities-to-templates.js");
    const report = await reconcileCapabilitiesToTemplates({});

    expect(createCapabilityFromDefinition).not.toHaveBeenCalled();
    expect(report.applied).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toBe("no drift");
  });
});

/**
 * The stamp must be EARNED. `contentHash` is what the fast path trusts to skip a
 * container entirely, so a hash stamped by a comparator that could not see a
 * field is not evidence about that field — it is a self-certifying miss (how
 * `intent` reached zero pods). The stamp therefore carries the comparator
 * version that cleared it, and the fast path honours it only for the current one.
 */
describe("reconcileCapabilitiesToTemplates — earned contentHash stamp", () => {
  const templateDef = {
    key: "tmpl-key",
    name: "Test Capability",
    updatePolicy: "auto" as const,
    contentHash: "hash-v1",
    tools: [{ name: "toolA" }],
    skills: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.memberSkillLinkRows = [];
    state.installedSkillRows = [];
    state.memberToolRows = [{ name: "toolA" }];
    state.updateCalls.length = 0;
    loadCapabilityTemplate.mockResolvedValue(templateDef);
    createCapabilityFromDefinition.mockResolvedValue(undefined);
  });

  it("does NOT fast-path a matching hash stamped by an older comparator", async () => {
    state.containersRows = [
      {
        id: "container-1",
        name: "Test Capability",
        createdBy: "user-1",
        workspaceId: null,
        // Hash matches the template, but no comparator version — i.e. cleared
        // by a comparator that did not read today's field set.
        metadata: { templateKey: "tmpl-key", contentHash: "hash-v1" },
      },
    ];

    const { reconcileCapabilitiesToTemplates } =
      await import("./reconcile-capabilities-to-templates.js");
    const report = await reconcileCapabilitiesToTemplates({});

    expect(report.skipped[0]!.reason).toBe("no drift");
    const stamped = state.updateCalls[0]!.set as {
      metadata: Record<string, unknown>;
    };
    expect(stamped.metadata.comparatorVersion).toBe(DRIFT_COMPARATOR_VERSION);
  });

  it("DOES fast-path a matching hash stamped by the current comparator", async () => {
    state.containersRows = [
      {
        id: "container-1",
        name: "Test Capability",
        createdBy: "user-1",
        workspaceId: null,
        metadata: {
          templateKey: "tmpl-key",
          contentHash: "hash-v1",
          comparatorVersion: DRIFT_COMPARATOR_VERSION,
        },
      },
    ];

    const { reconcileCapabilitiesToTemplates } =
      await import("./reconcile-capabilities-to-templates.js");
    const report = await reconcileCapabilitiesToTemplates({});

    expect(report.skipped[0]!.reason).toBe("up to date (contentHash match)");
    expect(state.updateCalls).toHaveLength(0);
  });

  it("detects a template that only ADDED an intent to a verb (the shipped miss)", async () => {
    loadCapabilityTemplate.mockResolvedValue({
      ...templateDef,
      contentHash: "hash-v2",
      skills: [
        {
          name: "gmail_send",
          kind: "declarative",
          requires: ["toolA"],
          parameters: {},
          intent: "send_message",
        },
      ],
    });
    state.containersRows = [
      {
        id: "container-1",
        name: "Test Capability",
        createdBy: "user-1",
        workspaceId: null,
        metadata: { templateKey: "tmpl-key", contentHash: "hash-v1" },
      },
    ];
    // The live skill row matches the definition on every projected field — the
    // ONLY difference is on the tool's verb catalog, which is where intent lives.
    state.memberSkillLinkRows = [{ fromId: "skill-1" }];
    state.installedSkillRows = [
      {
        name: "gmail_send",
        providerSpec: null,
        parameters: {},
        code: null,
        description: null,
        kind: "declarative",
        scope: "pod",
        category: null,
        agentTypes: null,
        executionMode: "sync",
        timeoutSeconds: 30,
      },
    ];
    state.memberToolRows = [
      {
        name: "toolA",
        capabilityCatalog: [
          {
            id: "gmail_send",
            label: "gmail_send",
            kind: "action",
            argsSchema: {},
            govDefault: "propose",
          },
        ],
      },
    ];

    const { reconcileCapabilitiesToTemplates } =
      await import("./reconcile-capabilities-to-templates.js");
    const report = await reconcileCapabilitiesToTemplates({});

    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]!.reason).toContain("verbCatalogDrift=[toolA]");
    expect(createCapabilityFromDefinition).toHaveBeenCalledTimes(1);
  });
});
