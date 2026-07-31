/**
 * Contract test for `capabilities.usedInProcesses` — extended to surface
 * playbooks that use a capability verb TRANSITIVELY, via the automation(s)
 * they're composed with (a playbook has no `flowDefinition`/verb-node storage
 * of its own — see the router doc comment). Verifies:
 *
 *  (a) automation rows are unchanged in content, now tagged `kind: "automation"`.
 *  (b) a playbook composing a matched automation via `flowAutomationId` is
 *      included as `kind: "playbook"`.
 *  (c) a playbook composing a matched automation via the `playbook_automations`
 *      join table is included as `kind: "playbook"`.
 *  (d) when NO automation matches the verb, no playbook query runs at all
 *      (mutation-test surface: the playbook backlink is only ever transitive
 *      through a real automation match, never a direct/fabricated one).
 *
 * DB is mocked (no live Postgres in CI); assertions are on the composed
 * query + scoping, not on Postgres row filtering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockGetDb, mockScopedDb, mockPredicate, mockAccessFrom } =
  vi.hoisted(() => {
    const predicate = vi.fn(() => ({ __visibility: true }));
    return {
      mockPredicate: predicate,
      mockScopedDb: vi.fn(() => ({ predicate })),
      mockAccessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
      mockDb: { query: {} },
      mockGetDb: vi.fn(),
    };
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    getDb: mockGetDb,
    and: vi.fn((...conditions) => ({ and: conditions.filter(Boolean) })),
    or: vi.fn((...conditions) => ({ or: conditions.filter(Boolean) })),
    eq: vi.fn((column, value) => ({ eq: [column, value] })),
    isNull: vi.fn((column) => ({ isNull: column })),
    inArray: vi.fn((column, values) => ({ inArray: [column, values] })),
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
        sql: strings.join("?"),
        values,
      })),
      { raw: vi.fn((s: string) => s) }
    ),
  };
});

vi.mock("../access/index.js", () => ({
  AccessContext: { from: mockAccessFrom },
  scopedDb: mockScopedDb,
}));

import { capabilitiesRouter } from "./capabilities.js";

/** Automation-side chain: select().from().where().orderBy() → rows. */
function automationChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn().mockResolvedValue(rows),
    _captured: captured,
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    captured.where = w;
    return chain;
  });
  return chain;
}

/** Playbook-side chain: selectDistinct().from().leftJoin().where().orderBy() → rows. */
function playbookChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn().mockResolvedValue(rows),
    _captured: captured,
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    captured.where = w;
    return chain;
  });
  return chain;
}

function callerCtx() {
  return { authenticated: true, userId: "user-1" } as never;
}

describe("capabilities.usedInProcesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredicate.mockReturnValue({ __visibility: true });
  });

  it("tags automation rows kind:'automation' and includes composing playbooks kind:'playbook'", async () => {
    const automations = automationChain([
      { automationId: "auto-1", name: "Enrich lead", status: "active" },
    ]);
    const pb = playbookChain([
      { playbookId: "pb-1", name: "Lead enrichment session", status: "active" },
    ]);

    let selectCall = 0;
    mockGetDb.mockResolvedValue({
      select: vi.fn(() => automations),
      selectDistinct: vi.fn(() => {
        selectCall += 1;
        return pb;
      }),
    });

    const caller = capabilitiesRouter.createCaller(callerCtx());
    const result = await caller.usedInProcesses({ verbId: "gmail.send" });

    expect(result).toEqual([
      {
        kind: "automation",
        automationId: "auto-1",
        name: "Enrich lead",
        status: "active",
      },
      {
        kind: "playbook",
        playbookId: "pb-1",
        name: "Lead enrichment session",
        status: "active",
      },
    ]);
    expect(selectCall).toBe(1);

    // Playbook query is scoped through the SAME access-layer predicate as
    // `list`/`listPage` — never a raw/unscoped read.
    expect(mockPredicate).toHaveBeenCalledTimes(2); // automations + playbooks
  });

  it("does NOT query playbooks at all when no automation matches the verb (no fabricated backlink)", async () => {
    const automations = automationChain([]);
    const selectDistinct = vi.fn();
    mockGetDb.mockResolvedValue({
      select: vi.fn(() => automations),
      selectDistinct,
    });

    const caller = capabilitiesRouter.createCaller(callerCtx());
    const result = await caller.usedInProcesses({ verbId: "unused.verb" });

    expect(result).toEqual([]);
    expect(selectDistinct).not.toHaveBeenCalled();
  });

  it("matches a playbook via EITHER flowAutomationId OR the playbook_automations join (OR, not AND)", async () => {
    const automations = automationChain([
      { automationId: "auto-1", name: "A", status: "active" },
    ]);
    const pb = playbookChain([]);
    mockGetDb.mockResolvedValue({
      select: vi.fn(() => automations),
      selectDistinct: vi.fn(() => pb),
    });

    const caller = capabilitiesRouter.createCaller(callerCtx());
    await caller.usedInProcesses({ verbId: "gmail.send" });

    const where = pb._captured.where as { and: unknown[] };
    const orClause = where.and.find(
      (c): c is { or: unknown[] } =>
        !!c && typeof c === "object" && "or" in (c as object)
    );
    expect(orClause).toBeDefined();
    expect(orClause!.or).toEqual([
      { inArray: [expect.anything(), ["auto-1"]] },
      { inArray: [expect.anything(), ["auto-1"]] },
    ]);
  });
});
