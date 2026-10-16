/**
 * OV-04 at the APPLIER: what a definition may make a reader.
 *
 * A pack from any catalog source installs through `createCapabilityFromDefinition`.
 * Driven through it against PGlite (every schema table), asserting the stored
 * `skills.url_patterns` — the column the reader door routes from:
 *   - a verb that does not declare `read_webpage` + `readOnly: true` stores no
 *     patterns, however many `urls` it lists (it would be handed people's links);
 *   - a pattern broader than one registrable domain (`*`, `*.co.uk`) is kept
 *     only when the caller says the definition is the OFFICIAL vendor's
 *     (`officialSource`) — a third-party pack keeps its narrow patterns only.
 * Side effects the applier reaches beyond the rows are stubbed as the sibling
 * `create-from-definition.mcp-reapproval.pglite.test.ts` does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
  getLinksFor: vi.fn(async () => []),
  deleteLink: vi.fn(async () => undefined),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({
        capability: { id: "33333333-3333-3333-3333-333333333333" },
      })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";

const UID = "22222222-2222-2222-2222-222222222222";
const WS = "11111111-1111-1111-1111-111111111111";

function apply(
  key: string,
  skill: Record<string, unknown>,
  opts: { officialSource?: boolean } = {}
) {
  return createCapabilityFromDefinition(
    {
      key,
      name: key,
      tools: [],
      skills: [
        {
          kind: "code",
          scope: "pod",
          code: "return { status: 'ok', title: 'x' };",
          parameters: { url: "string" },
          ...skill,
        },
      ],
      playbooks: [],
      vault: [],
    } as never,
    {},
    { userId: UID, workspaceId: WS, authenticated: true } as never,
    opts
  );
}

const patternsOf = async (name: string) =>
  (
    await h.client!.query<{ url_patterns: string[] | null }>(
      `select url_patterns from skills where name = $1`,
      [name]
    )
  ).rows.map((r) => r.url_patterns);

const READER = { intent: "read_webpage", metadata: { readOnly: true } };
const URLS = ["*", "*.co.uk", "news.example.org/a/*"];

beforeAll(async () => {
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(pgliteTableDdl(v));
  }
  expect(seen.has("skills")).toBe(true);
  // The intent row migration 0329 inserts.
  await h.client!.query(
    `insert into capability_intents (slug, effect, statement) values ('read_webpage', 'read', 'Read one web page')`
  );
  await h.client!.query(`insert into workspaces (id, name) values ($1, 'WS')`, [
    WS,
  ]);
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, UID]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from skills;`);
});

describe("the applier decides what may become a reader (OV-04)", () => {
  it("a third-party reader keeps only its narrow patterns; the official vendor keeps all", async () => {
    await apply("third-party", { name: "tp_read", ...READER, urls: URLS });
    expect(await patternsOf("tp_read")).toEqual([["news.example.org/a/*"]]);
    await apply(
      "official",
      { name: "off_read", ...READER, urls: URLS },
      { officialSource: true }
    );
    expect(await patternsOf("off_read")).toEqual([URLS]);
  });

  it("a verb that writes (or declares no read_webpage) stores no patterns, even from the official vendor", async () => {
    await apply(
      "writer",
      {
        name: "w_send",
        intent: "read_webpage",
        metadata: { readOnly: false },
        urls: ["news.example.org/a/*"],
      },
      { officialSource: true }
    );
    await apply(
      "no-intent",
      {
        name: "n_read",
        metadata: { readOnly: true },
        urls: ["news.example.org/a/*"],
      },
      { officialSource: true }
    );
    expect(await patternsOf("w_send")).toEqual([null]);
    expect(await patternsOf("n_read")).toEqual([null]);
  });
});
