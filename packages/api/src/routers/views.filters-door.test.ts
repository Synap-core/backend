/**
 * SEAM test: the views tRPC doors validate `filters` with the ONE view-filter
 * grammar (`ViewFiltersSchema`, `@synap-core/types/views`) instead of
 * `z.any()`. Drives the REAL router input parsers — a malformed filter is
 * refused as BAD_REQUEST before any handler runs, and a legacy alias (`eq`)
 * arrives at the handler already canonical.
 *
 * DB is mocked and never reached by the rejection cases.
 */
import { describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    query: { views: { findFirst: vi.fn().mockResolvedValue(undefined) } },
  },
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
  return { ...actual, db: mockDb, getDb: vi.fn().mockResolvedValue(mockDb) };
});
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
  message: expect.stringMatching(/"operator"|takes a list of values/),
};

const BAD_FILTERS = [
  [{ field: "properties.n", operator: "between", value: [1, 2] }],
  [{ field: "properties.status", operator: "in", value: "open" }],
];

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
  it.each(BAD_FILTERS)(
    "update refuses a malformed filter as BAD_REQUEST (%o)",
    async (filter) => {
      await expect(
        caller().update({ id: VIEW_ID, query: { filters: [filter] } } as never)
      ).rejects.toMatchObject(GRAMMAR_ISSUE);
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

  it("execute refuses malformed ephemeral filters as BAD_REQUEST", async () => {
    await expect(
      caller().execute({ id: VIEW_ID, filters: BAD_FILTERS[0] } as never)
    ).rejects.toMatchObject(GRAMMAR_ISSUE);
  });

  it("a legacy `eq` reaches every handler as `equals`", () => {
    const legacy = [{ field: "title", operator: "eq", value: "a" }];
    const canonical = [{ field: "title", operator: "equals", value: "a" }];
    expect(
      inputParser("update").parse({ id: VIEW_ID, query: { filters: legacy } })
        .query.filters
    ).toEqual(canonical);
    expect(
      inputParser("create").parse({
        name: "Board",
        type: "table",
        query: { filters: legacy },
      }).query.filters
    ).toEqual(canonical);
    expect(
      inputParser("execute").parse({ id: VIEW_ID, filters: legacy }).filters
    ).toEqual(canonical);
  });
});
