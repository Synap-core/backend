/**
 * `ask`'s procedural lane, driven end to end: the REAL `ask()` → its REAL
 * ignored-terms set → the REAL `knowledge_keys` full-text search on PGlite.
 *
 * Live defect: "I am changing a Synap desktop page, how do I check its user
 * flows?" missed the runbook written for exactly that question, and three
 * differently worded questions all returned the same three long notes. The
 * conversational frame survived as search terms, and every term is
 * prefix-matched, so `i:*` / `do:*` / `its:*` hit any long text ("in", "it",
 * "document", ...) and carried it over the two-term floor. Pinned:
 *  - the near-verbatim question finds its runbook first;
 *  - a question no runbook answers returns NO runbook, not the long notes.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: {},
    knowledgeKeysRepository: new actual.KnowledgeKeysRepository(
      drizzle(client, { schema }) as never
    ),
    knowledgeRepository: { searchFacts: async () => [] },
  };
});
// Only the procedural lane is under test; the other lanes answer empty.
vi.mock("../../retrieval/retrieve.js", () => ({
  retrieve: async () => ({
    entities: [],
    understanding: { confidence: 0 },
    verdict: "empty",
    source: "hybrid",
  }),
}));
vi.mock("../../library/ask-lane.js", () => ({
  searchLibraryForAsk: async () => ({ items: [], readTextSearch: "ok" }),
}));
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: async () => [],
}));
vi.mock("../../discover/space-catalog.js", () => ({
  suggestSpacesForKinds: async () => ({ status: "unavailable" }),
}));

const schema = await import("@synap/database/schema");
const { ask } = await import("../ask.js");

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const type = c.getSQLType();
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const RUNBOOK =
  "How to check user flows, navigation and journeys when changing a Synap page or screen (desktop app or phone app). Read the flows that walk the page before you edit it.";
// Long notes in the shape of the ones that answered every question: dense
// with words starting i/do/its, and sharing a couple of the question's words.
const LONG_NOTES = [
  "It is important: in its implementation the Synap user did it in the document, and it is done. ",
  "Its index is incomplete; it does it in its own document if it is invoked. The user checked it. ",
  "Inside it, the domain is implicit; it documents its inputs and it does it in time. ",
];

beforeAll(async () => {
  await h.client!.exec(ddlFor(schema.knowledgeKeys as unknown as PgTable));
  const rows: Array<[string, string]> = [
    ["design:flows-feedback-loop", RUNBOOK],
    ...LONG_NOTES.map((n, i): [string, string] => [
      `codestate:long-note-${i}`,
      n.repeat(40),
    ]),
  ];
  for (const [key, value] of rows) {
    const [namespace, slug] = key.split(":");
    await h.client!.query(
      `insert into knowledge_keys (key, namespace, slug, value) values ($1,$2,$3,$4)`,
      [key, namespace, slug, value]
    );
  }
}, 60_000);

async function procedural(query: string): Promise<string[]> {
  const r = await ask({
    query,
    // `knowledge_keys.workspace_id` is a uuid; the lane addresses the
    // user's namespace through it when no workspace is pinned.
    userId: "6f1c2a4e-0d3b-4c7a-9e21-5b8f3d2c1a90",
    workspaceId: null,
    catalog: [],
    limit: 3,
  });
  const lane = r.answers.find((a) => a.substrate === "procedural");
  expect(lane?.status).toBe("ok");
  return (lane!.items as Array<{ key: string }>).map((i) => i.key);
}

describe("ask — procedural recall of a runbook by its own question", () => {
  it("the near-verbatim question finds the runbook first", async () => {
    const keys = await procedural(
      "I am changing a Synap desktop page, how do I check its user flows?"
    );
    expect(keys[0]).toBe("design:flows-feedback-loop");
  });

  it("a question no runbook answers returns no runbook", async () => {
    expect(await procedural("how do I bake a sourdough bread?")).toEqual([]);
  });
});
