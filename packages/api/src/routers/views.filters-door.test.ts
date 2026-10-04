/**
 * SEAM test: the views tRPC doors validate `filters` with the ONE view-filter
 * grammar (`@synap-core/types/views`) instead of `z.any()`:
 *   - `create` validates at the input parser (a new view has no stored rows);
 *   - `update` / `execute` validate in the handler AGAINST THE VIEW'S STORED
 *     FILTERS: a NEW malformed filter is BAD_REQUEST, but a stored row that
 *     predates the grammar and is echoed back is repaired or dropped (and
 *     reported) — it can never block a save.
 *
 * DB and ViewRepository are mocked; nothing here reaches Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, repoUpdate } = vi.hoisted(() => ({
  mockDb: {
    query: { views: { findFirst: vi.fn().mockResolvedValue(undefined) } },
  },
  repoUpdate: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
    id,
    ...patch,
  })),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    getDb: vi.fn().mockResolvedValue(mockDb),
    ViewRepository: class {
      update = repoUpdate;
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("@synap/storage", () => ({
  storage: { buildPath: vi.fn(), upload: vi.fn() },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  })),
  invalidateSyncGenerationCache: vi.fn(),
}));

import { viewsRouter } from "./views.js";

const VIEW_ID = "00000000-0000-4000-8000-0000000000aa";
const caller = () =>
  viewsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: "00000000-0000-4000-8000-000000000010",
  } as never);

/** The zod issue names the grammar, so a handler-side BAD_REQUEST cannot pass. */
const GRAMMAR_ISSUE = {
  code: "BAD_REQUEST",
  message: expect.stringMatching(
    /"operator"|takes a list of values|Filter field must be/
  ),
};

const BAD_FILTERS: Array<[Record<string, unknown>]> = [
  [{ field: "properties.n", operator: "between", value: [1, 2] }],
  [{ field: "properties.status", operator: "in", value: "open" }],
  [{ field: "status", operator: "equals", value: "open" }],
];

/** Stored rows written before the grammar existed. */
const STORED_LEGACY = [
  { field: "properties.n", operator: "between", value: [1, 5] },
  { field: "status", operator: "equals", value: "open" }, // unrepairable
];

function storedView(filters: unknown[] = STORED_LEGACY) {
  return {
    id: VIEW_ID,
    workspaceId: null,
    userId: "user-1",
    type: "table",
    metadata: {},
    scopeProfileIds: ["00000000-0000-4000-8000-0000000000bb"],
    query: { filters },
  };
}

/** The router's own input parser for a procedure (tRPC v11 `_def.inputs`). */
function inputParser(name: "create" | "update" | "execute") {
  const procedure = (
    viewsRouter._def.procedures as unknown as Record<
      string,
      { _def: { inputs: Array<{ parse: (v: unknown) => any }> } }
    >
  )[name];
  const parser = procedure?._def.inputs[0];
  if (!parser) throw new Error(`no input parser on views.${name}`);
  return parser;
}

describe("views.* filters door", () => {
  beforeEach(() => {
    mockDb.query.views.findFirst.mockReset();
    mockDb.query.views.findFirst.mockResolvedValue(storedView());
    repoUpdate.mockClear();
  });

  it.each(BAD_FILTERS)(
    "update refuses a NEW malformed filter as BAD_REQUEST (%o)",
    async (filter) => {
      mockDb.query.views.findFirst.mockResolvedValue(storedView([]));
      await expect(
        caller().update({ id: VIEW_ID, query: { filters: [filter] } } as never)
      ).rejects.toMatchObject(GRAMMAR_ISSUE);
      expect(repoUpdate).not.toHaveBeenCalled();
    }
  );

  it.each(BAD_FILTERS)(
    "create refuses a malformed filter as BAD_REQUEST (%o)",
    async (filter) => {
      await expect(
        caller().create({
          name: "Board",
          type: "table",
          query: { filters: [filter] },
        } as never)
      ).rejects.toMatchObject(GRAMMAR_ISSUE);
    }
  );

  it("update SAVES a view whose stored filters predate the grammar: repaired, unrepairable dropped + reported", async () => {
    const added = { field: "title", operator: "contains", value: "x" };
    const result = await caller().update({
      id: VIEW_ID,
      // The client echoes the stored rows back with one new filter.
      query: { filters: [...STORED_LEGACY, added] },
    } as never);
    expect(repoUpdate).toHaveBeenCalledTimes(1);
    const saved = repoUpdate.mock.calls[0]![1] as {
      query: { filters: unknown[] };
    };
    expect(saved.query.filters).toEqual([
      { field: "properties.n", operator: "greater_than_or_equal", value: 1 },
      { field: "properties.n", operator: "less_than_or_equal", value: 5 },
      added,
    ]);
    expect(result.droppedFilters.map((d) => d.filter)).toEqual([
      STORED_LEGACY[1],
    ]);
  });

  it("update still refuses a new malformed filter next to echoed stored rows", async () => {
    await expect(
      caller().update({
        id: VIEW_ID,
        query: { filters: [...STORED_LEGACY, ...BAD_FILTERS[1]!] },
      } as never)
    ).rejects.toMatchObject(GRAMMAR_ISSUE);
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  it("execute refuses malformed ephemeral filters as BAD_REQUEST", async () => {
    mockDb.query.views.findFirst.mockResolvedValue(storedView([]));
    await expect(
      caller().execute({ id: VIEW_ID, filters: BAD_FILTERS[0] } as never)
    ).rejects.toMatchObject(GRAMMAR_ISSUE);
  });

  it("a legacy `eq` reaches the create handler as `equals`", () => {
    const legacy = [{ field: "title", operator: "eq", value: "a" }];
    const canonical = [{ field: "title", operator: "equals", value: "a" }];
    expect(
      inputParser("create").parse({
        name: "Board",
        type: "table",
        query: { filters: legacy },
      }).query.filters
    ).toEqual(canonical);
  });

  it("a legacy `eq` is saved by update as `equals`", async () => {
    await caller().update({
      id: VIEW_ID,
      query: { filters: [{ field: "title", operator: "eq", value: "a" }] },
    } as never);
    const saved = repoUpdate.mock.calls[0]![1] as {
      query: { filters: unknown[] };
    };
    expect(saved.query.filters).toEqual([
      { field: "title", operator: "equals", value: "a" },
    ]);
  });
});
