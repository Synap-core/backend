/**
 * `resolveIntelligenceService(...).agentUserId` — the acting identity of a
 * headless IS turn (automations, playbooks, background auto-respond) is only
 * ever a HOUSE agent (reach 'pod').
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

describe("IS turn acting identity — a house agent, never an external one", () => {
  it("workspace: an external member with its own key is skipped for the house agent", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    // External inserted FIRST, so an unfiltered `.limit(1)` returns it.
    await agent(human, "claude-code", { ws, key: "user_pat" });
    const house = await agent(human, "meta", { ws, key: "is_internal" });
    expect(await actingAgent(human, ws)).toBe(house);
  });

  it("workspace: an external member bound for dispatch is skipped for the house agent", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    await agent(human, "claude-code", { ws, bound: true });
    const house = await agent(human, "meta", { ws });
    expect(await actingAgent(human, ws)).toBe(house);
  });

  it("workspace: an agent with no agentType is not a house agent", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    await agent(human, "  ", { ws });
    const house = await agent(human, "meta", { ws });
    expect(await actingAgent(human, ws)).toBe(house);
  });

  it("workspace: only an external member ⇒ no acting agent, never the external one", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    await agent(human, "claude-code", { ws, key: "user_pat" });
    expect(await actingAgent(human, ws)).toBeUndefined();
  });

  it("workspace: two house agents ⇒ refuses to guess, like the pod-wide branch", async () => {
    const human = randomUUID();
    const ws = randomUUID();
    await agent(human, "meta", { ws });
    await agent(human, "builder", { ws });
    expect(await actingAgent(human, ws)).toBeUndefined();
  });

  it("pod-wide: an external agent does not make the house agent ambiguous", async () => {
    const human = randomUUID();
    await agent(human, "claude-code", { key: "user_pat" });
    const house = await agent(human, "meta");
    expect(await actingAgent(human)).toBe(house);
  });

  it("pod-wide: a sole external agent is never the acting agent", async () => {
    const human = randomUUID();
    await agent(human, "claude-code", { bound: true });
    expect(await actingAgent(human)).toBeUndefined();
  });
});
