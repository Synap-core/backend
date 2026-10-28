/**
 * `agents.update` / `agents.delete` write only the caller's own adjunct (or,
 * for a pod admin, any row), slugs stay unique across ALL active agents, and
 * `agents.list` never returns another person's private adjunct
 * (audit 2026-10-28, pod-routers F1 and F2).
 *
 * WHY: `agents` rows are pod-global. The write doors checked "manage" on the
 * caller's HEADER workspace (a space they can create themselves) and then
 * loaded the row by id alone, so anyone could deactivate the orchestrator
 * (every chat fallback then fails for every user) or rename another person's
 * adjunct. `create` deduplicated slugs only among user-owned rows, so a member
 * could take `orchestrator`, which chat paths resolve with `.limit(1)` and no
 * order. `list` had no owner floor at all.
 *
 * The non-admin is the OWNER of her own space: "manage" there is not enough.
 * Driven through the REAL procedures → the REAL `ownAdjunctFilter` and
 * `isPodAdmin` → SQL on PGlite. Stubbed: the db handle, the split-brain probe.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  agents,
  users,
} from "@synap/database/schema";
import { agentsRouter } from "./agents.js";

const ALICE = "alice";
const BOB = "bob";
const ADMIN = "pod-admin";
const ALICE_AGENT = "alice-agent-user";
const BOB_AGENT = "bob-agent-user";
const WS_ALICE = randomUUID();
const POD_ADMIN_WS = randomUUID();
const ORCH = randomUUID();
const ALICE_ADJ = randomUUID();
const BOB_ADJ = randomUUID();

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

const caller = (userId: string, workspaceId: string) =>
  agentsRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    workspaceId,
  } as never);
const alice = () => caller(ALICE, WS_ALICE);
const admin = () => caller(ADMIN, POD_ADMIN_WS);

type AgentRow = {
  id: string;
  agent_slug: string;
  name: string;
  active: boolean;
};
async function agentRow(id: string): Promise<AgentRow> {
  const { rows } = await h.client!.query<AgentRow>(
    `select id, agent_slug, name, active from agents where id = $1`,
    [id]
  );
  return rows[0]!;
}

beforeAll(async () => {
  for (const t of [workspaces, workspaceMembers, agents, users])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  for (const [id, type, createdBy] of [
    [ALICE, "human", null],
    [BOB, "human", null],
    [ADMIN, "human", null],
    [ALICE_AGENT, "agent", ALICE],
    [BOB_AGENT, "agent", BOB],
  ])
    await h.client!.query(
      `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, $3, $4)`,
      [id, `${id}@pod.example`, type, createdBy]
    );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Alice space', $2, '{}'::jsonb, now(), now())`,
    [WS_ALICE, ALICE]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, system_slug, created_at, updated_at)
     values ($1, 'Pod admin', $2, '{}'::jsonb, 'pod-admin', now(), now())`,
    [POD_ADMIN_WS, ADMIN]
  );
  for (const [ws, user] of [
    [WS_ALICE, ALICE],
    [POD_ADMIN_WS, ADMIN],
  ])
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, user]
    );
});

beforeEach(async () => {
  await h.client!.exec(`delete from agents;`);
  for (const [id, slug, ownerType, userId] of [
    [ORCH, "orchestrator", "system", null],
    [ALICE_ADJ, "alice-cli", "user", ALICE_AGENT],
    [BOB_ADJ, "bob-cli", "user", BOB_AGENT],
  ])
    await h.client!.query(
      `insert into agents (id, name, agent_slug, owner_type, user_id, active, created_at, updated_at)
       values ($1, $2, $3, $4, $5, true, now(), now())`,
      // name and slug as two parameters: one `$2` for a text and a varchar
      // column is "inconsistent types deduced" on PGlite.
      [id, slug, slug, ownerType, userId]
    );
});

describe("agents writes — a space owner touches only her own adjunct", () => {
  it("cannot deactivate the system orchestrator", async () => {
    await expect(
      alice().update({ id: ORCH, active: false })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await agentRow(ORCH)).active).toBe(true);
  });

  it("cannot rename another person's adjunct (it is not visible to her)", async () => {
    await expect(
      alice().update({ id: BOB_ADJ, name: "pwned" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await agentRow(BOB_ADJ)).name).toBe("bob-cli");
  });

  it("cannot deactivate another person's adjunct", async () => {
    await expect(alice().delete({ id: BOB_ADJ })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await agentRow(BOB_ADJ)).active).toBe(true);
  });

  it("cannot take the orchestrator slug or another active agent's slug", async () => {
    await expect(
      alice().update({ id: ALICE_ADJ, slug: "orchestrator" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      alice().update({ id: ALICE_ADJ, slug: "bob-cli" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      alice().create({ name: "Orch", slug: "orchestrator" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await agentRow(ALICE_ADJ)).agent_slug).toBe("alice-cli");
  });

  it("still renames and deactivates her own adjunct", async () => {
    await alice().update({ id: ALICE_ADJ, name: "Alice CLI" });
    expect((await agentRow(ALICE_ADJ)).name).toBe("Alice CLI");
    await alice().delete({ id: ALICE_ADJ });
    expect((await agentRow(ALICE_ADJ)).active).toBe(false);
  });
});

describe("agents writes — a pod admin manages the shared rows", () => {
  it("renames the orchestrator but cannot delete it", async () => {
    await admin().update({ id: ORCH, name: "House orchestrator" });
    expect((await agentRow(ORCH)).name).toBe("House orchestrator");
    await expect(admin().delete({ id: ORCH })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("agents.list — never another person's private adjunct", () => {
  it("returns the shared agents and her own adjunct only", async () => {
    const ids = (await alice().list({})).map((a) => a.id).sort();
    expect(ids).toEqual([ORCH, ALICE_ADJ].sort());
  });

  it("an ownerType filter cannot widen it", async () => {
    const ids = (await alice().list({ ownerType: "user" })).map((a) => a.id);
    expect(ids).toEqual([ALICE_ADJ]);
  });
});
