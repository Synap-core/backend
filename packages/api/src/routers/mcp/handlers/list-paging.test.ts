/**
 * PAGING on the two MCP list doors (plan 9992207a, c-paging).
 *
 * Before: `synap_get_entities` forwarded only `limit` and `synap_list_sessions`
 * capped at 50 with no offset, so a full-pod listing — what the title audit and
 * the backlog retitle need — was impossible through MCP.
 *
 * Now each door takes `offset` and answers `nextOffset` ONLY when another page
 * exists (it reads one row past the page to know). Asserted by walking every
 * page to the end: the union is the whole set, no row twice, and the last page
 * carries no `nextOffset`.
 *
 * `synap_get_entities` is driven with a fake hub caller that honours
 * limit/offset; `synap_list_sessions` runs its real query on PGlite.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

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
  return {
    ...actual,
    db: drizzle(client, { schema }),
  };
});
// Lineage is not what this file checks (it reads `links`, a separate concern).
vi.mock(
  "../../../services/focus-sessions/parent-lineage.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    attachParentSessionIds: async <T>(rows: T[]) => rows,
  })
);

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readHandlers } from "./read.js";
import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ENTITY_COUNT = 120;
const SESSION_COUNT = 57;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const rows = Array.from({ length: ENTITY_COUNT }, (_, i) => ({
  id: `e${i}`,
  title: `Entity ${i}`,
  profileSlug: "note",
}));
const getEntities = vi.fn(async (input: { limit: number; offset?: number }) =>
  rows.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit)
);

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read"],
    caller: { entities: { getEntities } },
  } as unknown as McpToolContext;
}
const json = (r: { content: Array<{ text?: string }> }) =>
  JSON.parse(r.content[0]!.text!);

async function walk(
  call: (offset: number) => Promise<Record<string, unknown>>,
  key: string
) {
  const seen: string[] = [];
  let offset = 0;
  let pages = 0;
  let last: Record<string, unknown> = {};
  for (;;) {
    last = await call(offset);
    pages++;
    seen.push(...(last[key] as Array<{ id: string }>).map((r) => r.id));
    if (typeof last.nextOffset !== "number") break;
    expect(last.nextOffset).toBeGreaterThan(offset);
    offset = last.nextOffset;
    if (pages > 100) throw new Error("paging never ended");
  }
  return { seen, pages, last };
}

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  // Two sessions share every start time, so only the id tie-break keeps the
  // order stable across pages.
  for (let i = 0; i < SESSION_COUNT; i++) {
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, status, started_at, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, 'active', $3, now(), now())`,
      [USER, `Goal ${i}`, new Date(Date.UTC(2026, 9, 1, 0, Math.floor(i / 2)))]
    );
  }
}, 120_000);

describe("synap_get_entities — pages to the end", () => {
  it("walks every row once, and the last page has no nextOffset", async () => {
    const { seen, pages, last } = await walk(
      async (offset) =>
        json(
          (await readHandlers.synap_get_entities!(
            ctx("synap_get_entities", {
              profileSlug: "note",
              limit: 50,
              offset,
            })
          )) as { content: Array<{ text?: string }> }
        ),
      "entities"
    );
    expect(pages).toBe(3);
    expect(seen).toHaveLength(ENTITY_COUNT);
    expect(new Set(seen).size).toBe(ENTITY_COUNT);
    expect(last).not.toHaveProperty("nextOffset");
    // One row past the page is how the door knows; it never returns it.
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      limit: 51,
      offset: 0,
    });
  });

  it("clamps a model's junk paging args instead of trusting them", async () => {
    getEntities.mockClear();
    const out = json(
      (await readHandlers.synap_get_entities!(
        ctx("synap_get_entities", { limit: "lots", offset: -5 })
      )) as { content: Array<{ text?: string }> }
    );
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      limit: 51,
      offset: 0,
    });
    expect(out.offset).toBe(0);
    expect(out.nextOffset).toBe(50);
  });
});

describe("synap_list_sessions — pages past 50", () => {
  it("walks every session once in a stable order", async () => {
    const { seen, pages, last } = await walk(
      async (offset) =>
        json(
          (await sessionHandlers.synap_list_sessions!(
            ctx("synap_list_sessions", { status: "all", limit: 20, offset })
          )) as { content: Array<{ text?: string }> }
        ),
      "sessions"
    );
    expect(pages).toBe(3);
    expect(seen).toHaveLength(SESSION_COUNT);
    expect(new Set(seen).size).toBe(SESSION_COUNT);
    expect(last).not.toHaveProperty("nextOffset");
  });

  it("still caps a page at 50", async () => {
    const out = json(
      (await sessionHandlers.synap_list_sessions!(
        ctx("synap_list_sessions", { status: "all", limit: 500 })
      )) as { content: Array<{ text?: string }> }
    );
    expect(out.count).toBe(50);
    expect(out.nextOffset).toBe(50);
  });
});
