/**
 * Contract test for `capabilities.registry.createVerb`'s WIRING step (G1).
 *
 * `skills.create` inserts a bare skill row and writes zero links, so a verb
 * created through this door used to be born ORPHANED — absent from every read
 * path that surfaces it. This test pins all three edges:
 *
 *  (a) `skill --requires--> tool`, via the existing `skills.setRequiredTools`;
 *  (b) `skill --member_of--> capability`, via `capabilities.containers.addPart`,
 *      for every container the PARENT TOOL belongs to;
 *  (c) the entry appended to the parent tool's `tools.capabilities` catalogue —
 *      in the exact `ToolVerbCatalogEntry` shape `deriveToolVerbs` produces —
 *      idempotently by verb id.
 *
 *  (d) the `proposed` branch writes NOTHING: the skill row does not exist yet,
 *      so there is nothing to link. Reported honestly via `wiring`.
 *
 * DB is mocked (no live Postgres in CI); assertions are on the writes issued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockCreate,
  mockSetRequiredTools,
  mockAddPart,
  mockScopedDb,
  mockAccessFrom,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockCreate: vi.fn(),
  mockSetRequiredTools: vi.fn(),
  mockAddPart: vi.fn(),
  mockScopedDb: vi.fn(() => ({ predicate: vi.fn(() => ({})) })),
  mockAccessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: {} },
    getDb: mockGetDb,
    and: vi.fn((...conditions) => ({ and: conditions.filter(Boolean) })),
    or: vi.fn((...conditions) => ({ or: conditions.filter(Boolean) })),
    eq: vi.fn((column, value) => ({ eq: [column, value] })),
    isNull: vi.fn((column) => ({ isNull: column })),
    inArray: vi.fn((column, values) => ({ inArray: [column, values] })),
  };
});

// `createVerb` is a mutation → the read-only-guard middleware runs first and
// calls isPodReadOnly() against the eager `db` singleton (real Postgres). No
// live PG in CI → stub it to "writable".
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../access/index.js", () => ({
  AccessContext: { from: mockAccessFrom },
  scopedDb: mockScopedDb,
}));

vi.mock("./skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({
      create: mockCreate,
      setRequiredTools: mockSetRequiredTools,
    }),
  },
}));

vi.mock("./capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({ addPart: mockAddPart }),
  },
}));

import { capabilitiesRouter } from "./capabilities.js";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";

/**
 * A drizzle-ish select chain that is BOTH chainable and awaitable, so the same
 * factory serves `…where().limit()` (parent tool / tool row) and a bare
 * `…where()` (the member_of link scan).
 */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    // `.for("update")` — the row lock createVerb takes before its
    // read-modify-write of the jsonb verb catalogue. Chainable no-op here: the
    // lock is a Postgres concern, but the mock must accept the call or the whole
    // catalogue-append branch throws and gets swallowed by its own try/catch.
    for: () => chain,
    limit: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return chain;
}

/**
 * Mock db serving the three reads createVerb issues, in order:
 *   1. parent tool · 2. member_of links · 3. the parent tool's verb catalogue.
 * Captures every `update().set()` payload.
 */
function mockDatabase(opts: {
  parentTool?: unknown[];
  containerLinks?: unknown[];
  toolCatalogue?: unknown[];
}) {
  const queue = [
    opts.parentTool ?? [{ id: "tool-1", name: "linear" }],
    opts.containerLinks ?? [],
    opts.toolCatalogue ?? [{ capabilities: [] }],
  ];
  const updates: Record<string, unknown>[] = [];
  const db: Record<string, unknown> = {
    // The catalogue append runs inside `database.transaction(...)` so the
    // select+update is serialized under a row lock (two concurrent createVerb
    // calls on one parent tool would otherwise lose an entry, silently — the
    // append reports `catalogued: true` either way). The mock runs the callback
    // against THIS same db object: no real isolation, but it exercises the real
    // code path. Without it the callback throws `transaction is not a function`,
    // the surrounding try/catch swallows it, and the suite reads as "no
    // catalogue entry written" — which is how this regression hid.
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
    select: () => selectChain(queue.shift() ?? []),
    update: () => {
      const u: Record<string, unknown> = {
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return u;
        },
        where: () => Promise.resolve(),
      };
      return u;
    },
  };
  return { updates, db };
}

function callerCtx() {
  return { authenticated: true, userId: "user-1" } as never;
}

const input = {
  toolName: "linear",
  verbName: "linear_list_issues",
  description: "List issues from Linear",
  method: "GET" as const,
  pathTemplate: "/issues",
  parameters: { limit: { type: "number" } },
};

describe("capabilities.registry.createVerb — wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: "skill-1", status: "created" });
    mockSetRequiredTools.mockResolvedValue({});
    mockAddPart.mockResolvedValue({ ok: true });
  });

  it("writes the requires edge, joins the parent tool's capability card, and appends the verb catalogue entry", async () => {
    const { db, updates } = mockDatabase({
      containerLinks: [{ capabilityId: "cap-1" }, { capabilityId: "cap-1" }],
      toolCatalogue: [{ capabilities: [] }],
    });
    mockGetDb.mockResolvedValue(db);

    const caller = capabilitiesRouter.createCaller(callerCtx());
    const result = await caller.registry.createVerb(input);

    // (a) requires edge — through the EXISTING door, with the parent tool.
    expect(mockSetRequiredTools).toHaveBeenCalledWith({
      skillId: "skill-1",
      toolIds: ["tool-1"],
    });

    // (b) member_of — once per DISTINCT container the parent tool belongs to.
    expect(mockAddPart).toHaveBeenCalledTimes(1);
    expect(mockAddPart).toHaveBeenCalledWith({
      capabilityId: "cap-1",
      partType: "skill",
      partId: "skill-1",
    });

    // (c) the catalogue entry, in the deriveToolVerbs shape.
    expect(updates).toHaveLength(1);
    const verbs = updates[0].capabilities as ToolVerbCatalogEntry[];
    expect(verbs).toEqual([
      {
        id: "linear_list_issues",
        label: "linear_list_issues",
        kind: "read",
        argsSchema: { limit: { type: "number" } },
        govDefault: "propose",
      },
    ]);

    expect(result.wiring).toEqual({
      requires: true,
      catalogued: true,
      capabilityIds: ["cap-1"],
    });
  });

  it("is idempotent: re-creating the same verb replaces its catalogue entry, never duplicates it", async () => {
    const { db, updates } = mockDatabase({
      toolCatalogue: [
        {
          capabilities: [
            {
              id: "linear_other",
              label: "linear_other",
              kind: "read",
              govDefault: "propose",
            },
            {
              id: "linear_list_issues",
              label: "linear_list_issues",
              kind: "action",
              govDefault: "auto",
            },
          ],
        },
      ],
    });
    mockGetDb.mockResolvedValue(db);

    const caller = capabilitiesRouter.createCaller(callerCtx());
    await caller.registry.createVerb(input);

    const verbs = updates[0].capabilities as ToolVerbCatalogEntry[];
    expect(verbs).toHaveLength(2);
    expect(verbs.filter((v) => v.id === "linear_list_issues")).toHaveLength(1);
    // Replaced in place — position preserved, fields refreshed.
    expect(verbs[1]).toMatchObject({
      id: "linear_list_issues",
      kind: "read",
      govDefault: "propose",
    });
  });

  it("writes NOTHING on the proposed branch — the skill row does not exist yet", async () => {
    mockCreate.mockResolvedValue({
      id: "skill-2",
      status: "proposed",
      proposalId: "prop-1",
    });
    const { db, updates } = mockDatabase({
      containerLinks: [{ capabilityId: "cap-1" }],
    });
    mockGetDb.mockResolvedValue(db);

    const caller = capabilitiesRouter.createCaller(callerCtx());
    const result = await caller.registry.createVerb(input);

    expect(mockSetRequiredTools).not.toHaveBeenCalled();
    expect(mockAddPart).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.status).toBe("proposed");
    expect(result.wiring).toEqual({
      requires: false,
      catalogued: false,
      capabilityIds: [],
    });
  });

  it("still returns the created verb when a container attach is refused, reporting it in `wiring`", async () => {
    mockAddPart.mockRejectedValue(new Error("FORBIDDEN"));
    const { db, updates } = mockDatabase({
      containerLinks: [{ capabilityId: "cap-1" }],
    });
    mockGetDb.mockResolvedValue(db);

    const caller = capabilitiesRouter.createCaller(callerCtx());
    const result = await caller.registry.createVerb(input);

    expect(result.status).toBe("created");
    expect(result.wiring.capabilityIds).toEqual([]);
    // The two edges that do NOT depend on container write access still landed.
    expect(result.wiring.requires).toBe(true);
    expect(updates).toHaveLength(1);
  });
});
