/**
 * Focused contract test for `automations.matchForEntity` — the
 * Capture→Automation matcher (mirror of `playbooks.matchForEntity`). Verifies
 * (a) it filters to status='active' AND triggerType='event' AND the
 * entity-create eventPattern set AND the profileSlug JSONB filter, (b) it
 * applies the SAME access-layer scoping as `list` (scopedDb(AccessContext.from
 * (ctx)) + the keep-globals workspace narrow), and (c) it returns the lean card
 * shape, [] when none.
 *
 * DB is mocked (no live Postgres in CI); the assertions are on the composed
 * query + scoping, not on Postgres row filtering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockScopedDb, mockPredicate, mockAccessFrom } = vi.hoisted(
  () => {
    const predicate = vi.fn(() => ({ __visibility: true }));
    return {
      mockPredicate: predicate,
      mockScopedDb: vi.fn(() => ({ predicate })),
      mockAccessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
      mockGetDb: vi.fn(),
    };
  }
);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: mockGetDb,
    and: vi.fn((...conditions) => ({ and: conditions.filter(Boolean) })),
    or: vi.fn((...conditions) => ({ or: conditions.filter(Boolean) })),
    eq: vi.fn((column, value) => ({ eq: [column, value] })),
    isNull: vi.fn((column) => ({ isNull: column })),
    desc: vi.fn((column) => ({ desc: column })),
    drizzleSql: vi.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({
        sql: strings.join("?"),
        values,
      })
    ),
  };
});

vi.mock("../access/index.js", () => ({
  AccessContext: { from: mockAccessFrom },
  scopedDb: mockScopedDb,
}));

import { automationsRouter } from "./automations.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";

/** Chainable select() builder whose terminal .orderBy resolves to `rows`. */
function selectChain(rows: unknown[]) {
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

function callerCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never;
}

describe("automations.matchForEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredicate.mockReturnValue({ __visibility: true });
  });

  it("matches active event automations by profileSlug and returns the card shape", async () => {
    const chain = selectChain([
      {
        id: "auto-1",
        name: "Onboard new person",
        description: "Kick off the onboarding flow",
        status: "active",
        triggerType: "event",
        triggerConfig: {
          eventPattern: "entity.create.completed",
          filters: { profileSlug: "person" },
        },
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = automationsRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "person",
      workspaceId: WORKSPACE,
    });

    expect(result).toEqual([
      {
        id: "auto-1",
        name: "Onboard new person",
        description: "Kick off the onboarding flow",
        triggerSummary: "On person created",
      },
    ]);

    // Scoping identical to `list`: scopedDb(AccessContext.from(ctx)).predicate.
    expect(mockAccessFrom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", workspaceId: WORKSPACE })
    );
    expect(mockScopedDb).toHaveBeenCalledTimes(1);
    expect(mockPredicate).toHaveBeenCalledTimes(1);

    // WHERE composes: the visibility predicate + keep-globals narrow +
    // status='active' + triggerType='event' + the entity-create eventPattern
    // set + the profileSlug filter carrying the requested slug.
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __visibility: true });
    // keep-globals workspace narrow: or(isNull(workspaceId), eq(..., WORKSPACE))
    expect(where.and).toContainEqual(
      expect.objectContaining({ or: expect.any(Array) })
    );
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["active"]) })
    );
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["event"]) })
    );
    // eventPattern candidate set is inlined as a static SQL literal.
    expect(where.and).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("entity.create.completed"),
      })
    );
    // profileSlug filter carries the requested slug as a bound value.
    expect(where.and).toContainEqual(
      expect.objectContaining({ values: expect.arrayContaining(["person"]) })
    );
  });

  it("summarizes an unfiltered entity-create trigger as 'On any entity created'", async () => {
    const chain = selectChain([
      {
        id: "auto-2",
        name: "Log every creation",
        description: null,
        status: "active",
        triggerType: "event",
        triggerConfig: { eventPattern: "entity.*" },
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = automationsRouter.createCaller(callerCtx());
    const [card] = await caller.matchForEntity({
      profileSlug: "deal",
      workspaceId: WORKSPACE,
    });

    expect(card).toEqual({
      id: "auto-2",
      name: "Log every creation",
      description: undefined,
      triggerSummary: "On any entity created",
    });
  });

  it("returns [] when no automation matches the profile", async () => {
    const chain = selectChain([]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = automationsRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "unmatched-profile",
      workspaceId: WORKSPACE,
    });

    expect(result).toEqual([]);
    expect(mockScopedDb).toHaveBeenCalledTimes(1);
  });
});
