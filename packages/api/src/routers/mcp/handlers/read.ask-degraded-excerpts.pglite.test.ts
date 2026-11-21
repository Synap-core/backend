/**
 * `synap_ask` with AI down still hands the agent its runbooks (plan §7: "with
 * AI down, a scoped key cannot read the pod's runbooks: `ask` gives titles
 * only"), and the words of the outage end with the payer action the IS stated.
 *
 * WHAT IS REAL: the MCP handler, `ask()` and its procedural lane on PGlite
 * `knowledge_keys`, `synthesizeAnswer` (its IS call answers a 402 refusal
 * envelope), the one failure door, the scoped-key door fence. STUBBED: the
 * lens resolver (it pins the space), the entity lane, the library lane, the
 * pending scan, the spaces hint.
 *
 * THE REACH ARGUMENT, asserted rather than assumed:
 *  - the SAME fence admits a key to the titles and to the excerpts: the AI
 *    preset (a scoped key: reads, proposes, writes nothing) passes
 *    `synap_ask`, the same grant pinned to one space does not, so it gets
 *    neither;
 *  - under the scoped key's grant, the excerpts are exactly the first
 *    procedural `sources` (same ids, same order): no row reaches an excerpt
 *    that is not already listed, and the other space's runbook is in neither.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

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
vi.mock("../../../services/knowledge/resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: W1, catalog: [] }),
}));
vi.mock("../../../services/retrieval/retrieve.js", () => ({
  retrieve: async () => ({
    entities: [],
    understanding: {
      profileTypes: [],
      propertyHints: [],
      temporal: false,
      confidence: 0,
      cleanedQuery: "",
    },
    source: "hybrid",
    vectorDown: false,
    verdict: "empty",
  }),
}));
vi.mock("../../../services/library/ask-lane.js", () => ({
  searchLibraryForAsk: async () => ({ items: [], readTextSearch: "ok" }),
}));
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: async () => [],
}));
vi.mock("../../../services/discover/space-catalog.js", () => ({
  suggestSpacesForKinds: async () => ({ status: "unavailable" }),
}));
vi.mock("../../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultActiveService: async () => ({
    endpoint: "http://is.test",
    apiKey: "k",
  }),
}));

const schema = await import("@synap/database/schema");
const { runWithGrant } = await import("@synap/database");
const { readHandlers } = await import("./read.js");
const { mcpToolAllowed } = await import("../../../access/grant-door-fence.js");

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

const LONG_STEP =
  "Run the backend deploy checklist, then watch the release gate until it is green. ";
const RUNBOOKS: Array<[string, string, string]> = [
  [W1, "ops:backend-deploy", `To deploy the backend: ${LONG_STEP.repeat(12)}`],
  [
    W1,
    "ops:backend-deploy-rollback",
    "Roll back a backend deploy: revert the merge, then deploy the backend again.",
  ],
  [
    W1,
    "ops:backend-deploy-secrets",
    "Before a backend deploy, rotate the deploy secrets of the backend.",
  ],
  // A second long runbook: the lane ranks the four (only three are quoted),
  // so with two long ones at least one long runbook is always quoted, whatever
  // the rank order.
  [
    W1,
    "ops:backend-deploy-notes",
    `Backend deploy notes: every backend deploy is announced in the room. ${LONG_STEP.repeat(12)}`,
  ],
  [
    W2,
    "other:backend-deploy",
    "The other space's backend deploy runbook: OTHER-SPACE-ONLY.",
  ],
];

beforeAll(async () => {
  await h.client!.exec(ddlFor(schema.knowledgeKeys as unknown as PgTable));
  for (const [ws, key, value] of RUNBOOKS) {
    const [namespace, slug] = key.split(":");
    await h.client!.query(
      `insert into knowledge_keys (key, namespace, slug, value, workspace_id) values ($1,$2,$3,$4,$5)`,
      [key, namespace, slug, value, ws]
    );
  }
}, 60_000);

afterEach(() => vi.unstubAllGlobals());

/** The IS answers the synthesis call with this status and body. */
function isAnswers(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status }))
  );
}

const AI_PRESET = GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
  .grant.permissions;
const SCOPED = { scopes: [{ permissions: AI_PRESET }], clientId: null };
const PINNED = {
  scopes: [{ permissions: AI_PRESET, workspaceIds: [W1] }],
  clientId: null,
};

async function askAs(grant: typeof SCOPED): Promise<Record<string, any>> {
  const res = (await runWithGrant(grant as never, () =>
    readHandlers.synap_ask!({
      toolName: "synap_ask",
      args: { query: "how do I deploy the backend", detail: "full" },
      userId: "33333333-3333-4333-8333-333333333333",
      apiKeyScopes: ["mcp.read"],
      caller: {} as never,
      lensCaller: {} as never,
      workspaceAccessible: true,
    } as never)
  )) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

describe("synap_ask with AI down, through a scoped key", () => {
  it("the same fence admits the titles and the excerpts: the scoped key passes, pinned it does not", () => {
    expect(mcpToolAllowed("synap_ask", true, SCOPED as never)).toBe(true);
    expect(mcpToolAllowed("synap_ask", true, PINNED as never)).toBe(false);
  });

  it("quotes the first three listed runbooks, bounded, and nothing unlisted", async () => {
    isAnswers(402, {
      error: "AI credits empty",
      failure: {
        code: "credits_empty",
        retryable: false,
        actor: "payer",
        action: "ask_admin",
      },
    });
    const reply = await askAs(SCOPED);

    expect(reply.error).toBe("synthesis_unavailable");
    const listed = (
      reply.sources as Array<{ substrate: string; id: string; title: string }>
    ).filter((s) => s.substrate === "procedural");
    // Non-vacuity: the lane found the four runbooks of this space.
    expect(listed.map((s) => s.title).sort()).toEqual([
      "ops:backend-deploy",
      "ops:backend-deploy-notes",
      "ops:backend-deploy-rollback",
      "ops:backend-deploy-secrets",
    ]);
    const excerpts = reply.excerpts as Array<{
      id: string;
      title: string;
      text: string;
    }>;
    expect(excerpts.map((e) => e.id)).toEqual(
      listed.slice(0, 3).map((s) => s.id)
    );
    // Each excerpt is its runbook's opening: whole when it fits, else cut
    // with an ellipsis. At least one quoted runbook is long (see RUNBOOKS).
    const bodyOf = new Map(RUNBOOKS.map(([, key, value]) => [key, value]));
    let cut = 0;
    for (const e of excerpts) {
      expect(e.text.length).toBeLessThanOrEqual(600);
      const body = bodyOf.get(e.title)!;
      if (body.length > 600) {
        cut += 1;
        expect(e.text.endsWith("…")).toBe(true);
        expect(body.startsWith(e.text.slice(0, -1))).toBe(true);
      } else {
        expect(e.text).toBe(body);
      }
    }
    expect(cut).toBeGreaterThan(0);
    // The other space's runbook is neither listed nor quoted.
    expect(JSON.stringify(reply)).not.toContain("OTHER-SPACE-ONLY");
    expect(JSON.stringify(reply)).not.toContain("other:backend-deploy");
    expect(reply.message).toMatch(/`excerpts` quotes the opening/);
  });

  it("the words end with the action the IS stated, and the envelope is no field", async () => {
    isAnswers(402, {
      failure: {
        code: "credits_empty",
        retryable: false,
        actor: "payer",
        action: "ask_admin",
      },
    });
    const reply = await askAs(SCOPED);
    expect(reply.message).toMatch(
      /out of AI credits.*Captures still save\. Ask the pod's owner to top up credits\./
    );
    expect(reply.message).not.toMatch(/operator/i);
    expect(reply).not.toHaveProperty("failure");
  });

  it("a successful answer quotes nothing", async () => {
    isAnswers(200, { answer: "Merge to main, then watch the release gate." });
    const reply = await askAs(SCOPED);
    expect(reply.answer).toContain("release gate");
    expect(reply).not.toHaveProperty("excerpts");
  });
});
