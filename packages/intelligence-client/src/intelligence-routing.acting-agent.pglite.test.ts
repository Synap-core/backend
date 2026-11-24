/**
 * `resolveIntelligenceService(...).agentUserId` — the acting identity of an
 * IS turn (runs, chat, automations, background auto-respond) is the person's
 * ONE personal AI, in every space (decision 6b45c6c3). It used to be a HOUSE
 * agent guessed from space membership (else nobody, so the person); the old
 * cases below that guess now pin the personal AI instead.
 *
 * The workspace branch used to take ANY agent user the human created that is a
 * member of the space (`.limit(1)`), so an IS turn could be credited to — and
 * governed as — an EXTERNAL agent (Claude Code, a devbox agent…) that happened
 * to be a member. External = a `dispatched_via` binding, or a non-internal key
 * it owns, or no agentType: the signals `resolveAgentReach` reads.
 *
 * Driven through the REAL resolver → REAL SQL on PGlite. Only `db` is swapped.
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions without FKs/NOT NULL), and the `@synap/api`
 * classifier itself — parity is by comment, not by import (layering).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The first exec boots PGlite (WASM) inside beforeAll: ~5 s alone, past the
// default 10 s hook timeout on a CI runner testing every package in parallel
// (CI run 39259878520: "Hook timed out in 10000ms"). Same allowance as the
// database package's PGlite suites.
vi.setConfig({ hookTimeout: 120_000 });

const h = vi.hoisted(() => {
  // `@synap-core/core` validates config on import; the pool is never used.
  process.env.DATABASE_URL ??= "postgresql://unused@localhost:5432/unused";
  return {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  workspaces,
  workspaceMembers,
  userPreferences,
  intelligenceServices,
  links,
  apiKeys,
} from "@synap/database/schema";
import { resolveIntelligenceService } from "./intelligence-routing.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

async function agent(
  owner: string,
  agentType: string | null,
  opts: { ws?: string; key?: string; bound?: boolean } = {}
): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into users (id, user_type, agent_type, created_by_user_id)
     values ($1, 'agent', $2, $3)`,
    [id, agentType, owner]
  );
  if (opts.ws)
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values ($1, $2, $3, 'member')`,
      [randomUUID(), opts.ws, id]
    );
  if (opts.key)
    await h.client!.query(
      `insert into api_keys (id, user_id, key_type) values ($1, $2, $3)`,
      [randomUUID(), id, opts.key]
    );
  if (opts.bound)
    await h.client!.query(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type)
       values ($1, 'participant', $2, 'tool', $3, 'dispatched_via')`,
      [randomUUID(), id, randomUUID()]
    );
  return id;
}

const actingAgent = async (userId: string, workspaceId?: string) =>
  (await resolveIntelligenceService({ userId, workspaceId })).agentUserId;

beforeAll(async () => {
  for (const t of [
    users,
    workspaces,
    workspaceMembers,
    userPreferences,
    intelligenceServices,
    links,
    apiKeys,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
});

/** The person's personal AI, as `ensurePersonalAgentUser` makes it. */
async function personal(owner: string): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into users (id, user_type, agent_type, created_by_user_id, is_personal_agent)
     values ($1, 'agent', 'orchestrator', $2, true)`,
    [id, owner]
  );
  return id;
}

async function personalAgentsOf(owner: string): Promise<string[]> {
  const { rows } = await h.client!.query<{ id: string }>(
    `select id from users where created_by_user_id = $1 and is_personal_agent = true`,
    [owner]
  );
  return rows.map((r) => r.id);
}

async function membershipsOf(agentId: string): Promise<number> {
  const { rows } = await h.client!.query<{ n: number }>(
    `select count(*)::int as n from workspace_members where user_id = $1`,
    [agentId]
  );
  return rows[0]!.n;
}

describe("IS turn acting identity — the person's one personal AI (decision 6b45c6c3)", () => {
  it("a space whose ONE house member is a persona ⇒ the personal AI, not the persona", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    const mine = await personal(human);
    await agent(human, "meta", { ws, key: "is_internal" });
    expect(await actingAgent(human, ws)).toBe(mine);
  });

  it("a space with several house agents ⇒ the personal AI, never nobody", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    const mine = await personal(human);
    await agent(human, "meta", { ws });
    await agent(human, "builder", { ws });
    expect(await actingAgent(human, ws)).toBe(mine);
  });

  it("a space whose only member is an external agent ⇒ the personal AI, never the external one", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    const external = await agent(human, "claude-code", { ws, key: "user_pat" });
    const acting = await actingAgent(human, ws);
    expect(acting).not.toBe(external);
    expect(await personalAgentsOf(human)).toEqual([acting]);
  });

  it("no personal AI yet ⇒ created once, pod-wide, and never enrolled in the space", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    const first = await actingAgent(human, ws);
    expect(first).toBeDefined();
    expect(await actingAgent(human, ws)).toBe(first);
    expect(await actingAgent(human)).toBe(first);
    expect(await personalAgentsOf(human)).toEqual([first]);
    expect(await membershipsOf(first!)).toBe(0);
  });

  it("the same personal AI in every space and pod-wide", async () => {
    const human = randomUUID();
    const mine = await personal(human);
    await agent(human, "meta", { ws: randomUUID() });
    expect(await actingAgent(human, randomUUID())).toBe(mine);
    expect(await actingAgent(human)).toBe(mine);
  });

  it("another person's personal AI is never theirs", async () => {
    const human = randomUUID();
    const other = randomUUID();
    const theirs = await personal(other);
    const mine = await personal(human);
    expect(await actingAgent(human)).toBe(mine);
    expect(await actingAgent(human)).not.toBe(theirs);
  });
});
