/**
 * The agent read floor on a REAL Postgres (PGlite): who may read an
 * agent-user's scorecard (`agentScorecard`) and profile (`agentProfile`), and
 * resolve its id
 * (`resolveObjectKind`'s agent probe). Its owner, or a pod admin — an admin
 * answers for every agent on the pod (Pod Console DECISIONS bug 6). Anyone
 * else gets the "no such agent" answer, so neither door confirms it exists.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { agentProfile } from "../agent-profile.js";
import { agentScorecard } from "../agent-scorecard.js";
import { resolveObjectKind } from "../resolve-object-kind.js";

const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const POD_ADMIN_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.hasDefault && type === "jsonb"
          ? ` default '{}'::jsonb`
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  for (const [id, name] of [
    [OWNER, "Owner"],
    [ADMIN, "Admin"],
    [MEMBER, "Member"],
  ] as const) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, `${name.toLowerCase()}@x.test`, name]
    );
  }
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, 'a@x.test', 'Probe agent', 'agent', 'probe', $2)`,
    [AGENT, OWNER]
  );
  // The pod-admin system workspace: ADMIN is its admin, MEMBER a plain member.
  await q(
    `insert into workspaces (id, name, owner_id, system_slug) values ($1, 'Pod admin', $2, 'pod-admin')`,
    [POD_ADMIN_WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'admin'), ($4, $2, $5, 'member')`,
    [randomUUID(), POD_ADMIN_WS, ADMIN, randomUUID(), MEMBER]
  );
  // A space all three belong to, where the agent proposed twice.
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $2, $5, 'member'), ($6, $2, $7, 'member')`,
    [randomUUID(), WS, OWNER, randomUUID(), ADMIN, randomUUID(), MEMBER]
  );
  for (const status of ["approved", "rejected"]) {
    await q(
      `insert into proposals (id, workspace_id, target_type, proposal_type, status, data, created_by, agent_user_id)
       values ($1, $2, 'entity', 'create', $3, '{}'::jsonb, $4, $4)`,
      [randomUUID(), WS, status, AGENT]
    );
  }
});

describe("the agent read floor: its owner or a pod admin", () => {
  it("the owner reads its agent's scorecard and resolves its id", async () => {
    const card = await agentScorecard({ userId: OWNER, agentId: AGENT });
    expect("error" in card).toBe(false);
    expect((await resolveObjectKind(AGENT, OWNER))?.kind).toBe("agent");
  });

  it("a pod admin reads another member's agent (scorecard and resolver)", async () => {
    const card = await agentScorecard({ userId: ADMIN, agentId: AGENT });
    expect("error" in card).toBe(false);
    if ("error" in card) return;
    expect(card.agentName).toBe("Probe agent");
    expect(card.counts.total).toBe(2);
    const profile = await agentProfile({ userId: ADMIN, agentId: AGENT });
    expect("error" in profile ? profile.error : profile.createdByUserId).toBe(
      OWNER
    );
    const resolved = await resolveObjectKind(AGENT, ADMIN);
    expect(resolved?.kind).toBe("agent");
    expect(resolved?.displayName).toBe("Probe agent");
  });

  it("a member who is not the owner is refused — as if the agent did not exist", async () => {
    expect(await agentScorecard({ userId: MEMBER, agentId: AGENT })).toEqual({
      error: `No agent-user found for id ${AGENT}`,
    });
    expect(await agentProfile({ userId: MEMBER, agentId: AGENT })).toEqual({
      error: `No agent-user found for id ${AGENT}`,
    });
    expect(await resolveObjectKind(AGENT, MEMBER)).toBeNull();
  });

  it("a human's id is never read as an agent, even by a pod admin", async () => {
    expect(await agentScorecard({ userId: ADMIN, agentId: MEMBER })).toEqual({
      error: `No agent-user found for id ${MEMBER}`,
    });
  });
});
