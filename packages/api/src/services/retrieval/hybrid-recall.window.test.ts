/**
 * A recall window (`since` / `until`, ticket a9888512) is a FILTER on the
 * candidate fetch of BOTH recall halves, at query time: the pool is drawn from
 * inside the window, before anything is ranked. The bug it fixes: recency was
 * only a nudge in the ranker, so a report of this week whose words matched
 * weakly never entered the pool at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Node = { op: string; args: unknown[] };
const node =
  (op: string) =>
  (...args: unknown[]): Node => ({ op, args });

const vectorWheres: unknown[] = [];
const subquery = { sub: true };
const subWheres: Node[] = [];
const searches: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const vectorChain = {
    from: () => vectorChain,
    where: (w: unknown) => {
      vectorWheres.push(w);
      return vectorChain;
    },
    orderBy: () => vectorChain,
    limit: async () => [],
  };
  const subChain = {
    from: () => subChain,
    where: (w: Node) => {
      subWheres.push(w);
      return subquery;
    },
  };
  return {
    ...actual,
    db: {
      select: (cols: Record<string, unknown>) =>
        "entityId" in cols ? vectorChain : subChain,
    },
    entities: {
      id: "entities.id",
      workspaceId: "entities.workspaceId",
      updatedAt: "entities.updatedAt",
    },
    entityVectors: {
      entityId: "ev.entityId",
      embedding: "ev.embedding",
      entityType: "ev.entityType",
    },
    eq: node("eq"),
    and: node("and"),
    or: node("or"),
    gte: node("gte"),
    lt: node("lt"),
    isNull: node("isNull"),
    inArray: node("inArray"),
    drizzleSql: () => ({ op: "sql", args: [] }),
    resolveSlugKind: vi.fn(),
    loadFacetSlugsBatch: vi.fn(),
    listableEntityWhere: vi.fn(),
  };
});
vi.mock("@synap/search", () => ({
  searchService: {
    search: async (options: Record<string, unknown>) => {
      searches.push(options);
      return { results: [] };
    },
  },
}));
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock("../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService: vi.fn(),
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: async () => undefined,
}));
vi.mock("../../utils/project-scope.js", () => ({ accessScopeWhere: vi.fn() }));

const { hybridRecall } = await import("./hybrid-recall.js");

const SINCE = new Date("2026-11-16T00:00:00.000Z");
const UNTIL = new Date("2026-11-18T00:00:00.000Z");

const run = (window?: { since?: Date; until?: Date }) =>
  hybridRecall({
    query: "what did my routines find",
    userId: "u",
    workspaceId: null,
    limit: 5,
    embedding: [0.1, 0.2],
    ...(window ? { window } : {}),
  });

const flat = (n: unknown): Node[] =>
  n && typeof n === "object" && "op" in n
    ? [n as Node, ...(n as Node).args.flatMap(flat)]
    : [];

beforeEach(() => {
  vectorWheres.length = 0;
  subWheres.length = 0;
  searches.length = 0;
});

describe("hybridRecall — a window filters both halves at query time", () => {
  it("the vector half draws only entities updated inside the window", async () => {
    await run({ since: SINCE, until: UNTIL });
    const nodes = flat(vectorWheres[0]);
    expect(
      nodes.some((n) => n.op === "inArray" && n.args[1] === subquery)
    ).toBe(true);
    expect(subWheres).toEqual([
      {
        op: "and",
        args: [
          { op: "gte", args: ["entities.updatedAt", SINCE] },
          { op: "lt", args: ["entities.updatedAt", UNTIL] },
        ],
      },
    ]);
  });

  it("the keyword half asks the index for the same window, in its unit (seconds)", async () => {
    await run({ since: SINCE, until: UNTIL });
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      updatedSince: 1794787200,
      updatedUntil: 1794960000,
    });
  });

  it("no window, no condition and no index filter", async () => {
    await run();
    expect(subWheres).toEqual([]);
    expect(searches[0]).not.toHaveProperty("updatedSince");
    expect(searches[0]).not.toHaveProperty("updatedUntil");
  });
});
