/**
 * `agentUsers.setBinding` REPLACES an agent's binding as ONE transaction
 * (S7): drop the old `dispatched_via` edge, write the new one. A create that
 * fails must roll the delete back — the agent keeps its old binding instead
 * of silently ending up with none.
 *
 * Real: the router, the owner check, the transaction, `links` rows on PGlite,
 * the links write door. Stubbed: the tool read (`scopedDb` — the access
 * layer's own suite) and, for the failure case, the link insert.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  failCreate: false,
  tool: null as null | Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      users: actual.users as never,
      links: actual.links as never,
      apiKeys: actual.apiKeys as never,
      tools: actual.tools as never,
    },
  });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../access/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scopedDb: () => ({ findFirst: async () => h.tool }),
}));
vi.mock("../services/links/links-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/links/links-service.js")>();
  return {
    ...actual,
    createLink: async (...a: Parameters<typeof actual.createLink>) => {
      if (h.failCreate) throw new Error("insert failed");
      return actual.createLink(...a);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { users, links, apiKeys, tools } from "@synap/database/schema";
import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const raw = c.getSQLType();
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type = BASIC.test(base) ? base : "text";
    return `"${c.name}" ${type}${raw.endsWith("[]") ? "[]" : ""}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const AGENT = randomUUID();
const OLD_TOOL = randomUUID();
const NEW_TOOL = randomUUID();

const caller = () =>
  agentUsersRouter.createCaller({
    authenticated: true,
    userId: OWNER,
  } as unknown as Context);
const boundTo = async () =>
  (
    await q<{ to_id: string }>(
      `select to_id from links where from_id = $1 and link_type = 'dispatched_via'`,
      [AGENT]
    )
  ).rows.map((r) => r.to_id);

beforeAll(async () => {
  for (const t of [users, links, apiKeys, tools]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.exec(
    `create unique index links_edge on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'o@x', 'human', null), ($2, 'a@x', 'agent', $1)`,
    [OWNER, AGENT]
  );
}, 120_000);

beforeEach(async () => {
  h.failCreate = false;
  await q(`delete from links`);
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
    [randomUUID(), AGENT, OLD_TOOL]
  );
  h.tool = {
    id: NEW_TOOL,
    workspaceId: null,
    kind: "external",
    executor: "external-agent",
    status: "active",
    config: {
      agentBinding: {
        protocol: "a2a",
        provider: "acme",
        supports: { push: false, inputRequired: true, cancel: false },
        verbs: { start: "s", send: "m" },
      },
    },
  };
});

describe("agentUsers.setBinding — replace is one transaction", () => {
  it("rebinding swaps the edge", async () => {
    await caller().setBinding({ agentUserId: AGENT, toolId: NEW_TOOL });
    expect(await boundTo()).toEqual([NEW_TOOL]);
  });

  it("a create that FAILS keeps the old binding (the delete rolls back)", async () => {
    h.failCreate = true;
    await expect(
      caller().setBinding({ agentUserId: AGENT, toolId: NEW_TOOL })
    ).rejects.toThrow();
    expect(await boundTo()).toEqual([OLD_TOOL]);
  });
});
