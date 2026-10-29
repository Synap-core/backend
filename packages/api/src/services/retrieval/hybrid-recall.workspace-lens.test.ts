/**
 * An explicit workspace lens must constrain BOTH recall halves. The keyword half
 * filters `workspaceId = ws OR pod-wide`; the pgvector half has no workspace
 * column, so it must apply the same condition through the entity's own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Node = { op: string; args: unknown[] };
const node =
  (op: string) =>
  (...args: unknown[]): Node => ({ op, args });

const vectorWheres: unknown[] = [];
const subquery = { sub: true };
const subWheres: Node[] = [];

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
    entities: { id: "entities.id", workspaceId: "entities.workspaceId" },
    entityVectors: {
      entityId: "ev.entityId",
      embedding: "ev.embedding",
      entityType: "ev.entityType",
    },
    eq: node("eq"),
    and: node("and"),
    or: node("or"),
    isNull: node("isNull"),
    inArray: node("inArray"),
    drizzleSql: () => ({ op: "sql", args: [] }),
    resolveSlugKind: vi.fn(),
    loadFacetSlugsBatch: vi.fn(),
    listableEntityWhere: vi.fn(),
  };
});
vi.mock("@synap/search", () => ({
  searchService: { search: async () => ({ results: [] }) },
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

const run = (workspaceId: string | null) =>
  hybridRecall({
    query: "q",
    userId: "u",
    workspaceId,
    limit: 5,
    embedding: [0.1, 0.2],
  });

const flat = (n: unknown): Node[] =>
  n && typeof n === "object" && "op" in n
    ? [n as Node, ...(n as Node).args.flatMap(flat)]
    : [];

beforeEach(() => {
  vectorWheres.length = 0;
  subWheres.length = 0;
});

describe("hybridRecall — workspace lens on the vector half", () => {
  it("restricts to the workspace's entities plus pod-scoped ones", async () => {
    await run("ws-1");
    const nodes = flat(vectorWheres[0]);
    const lens = nodes.find(
      (n) => n.op === "inArray" && n.args[1] === subquery
    );
    expect(lens).toBeDefined();
    const [cond] = subWheres;
    expect(cond.op).toBe("or");
    expect(cond.args).toEqual([
      { op: "eq", args: ["entities.workspaceId", "ws-1"] },
      { op: "isNull", args: ["entities.workspaceId"] },
    ]);
  });

  it("adds no workspace condition without a lens", async () => {
    await run(null);
    const nodes = flat(vectorWheres[0]);
    expect(nodes.some((n) => n.args.includes(subquery))).toBe(false);
  });
});
