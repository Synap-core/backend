/**
 * ASSIGN and PAUSE (W1b), read back out of PGlite:
 *   - one agent per target: assigning a target replaces whoever held it;
 *   - removing drops only THIS agent's edge;
 *   - only the agent's owner (or a pod admin) may assign or pause it;
 *   - pausing stamps who and when; resuming clears both.
 *
 * Real: the tables, the service. Stubbed: the endpoint-visibility floor (its
 * own suite), the pod-admin check, the audit log; `createLink` writes the row
 * through the transaction it is handed.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  admin: false,
  visible: true,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("../../../utils/workspace-role.js", () => ({
  isPodAdmin: async () => h.admin,
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: async () => undefined }));
vi.mock(
  "../../../routers/hub-protocol/rest/link-endpoint-visibility.js",
  () => ({
    checkLinkEndpointVisible: async () =>
      h.visible ? null : { status: 404, error: "Playbook not found" },
  })
);
vi.mock("../../links/links-service.js", () => ({
  createLink: async (
    input: Record<string, unknown>,
    tx: { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } }
  ) => {
    const { links } = await import("@synap/database");
    await tx.insert(links).values(input);
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { users, links } from "@synap/database";
import { setAgentAssignment, setAgentPaused } from "../agent-assignment.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}${c.name === "metadata" ? " default '{}'::jsonb" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const STRANGER = randomUUID();
const A = randomUUID();
const B = randomUUID();
const PLAYBOOK = randomUUID();
/** The stranger's own agent. */
const THEIRS = randomUUID();

beforeAll(async () => {
  for (const t of [users, links]) await h.client!.exec(ddlFor(t as PgTable));
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x', 'human'), ($2, 's@x', 'human')`,
    [OWNER, STRANGER]
  );
  for (const id of [A, B]) {
    await q(
      `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
      [id, `${id}@x`, OWNER]
    );
  }
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
    [THEIRS, `${THEIRS}@x`, STRANGER]
  );
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

const holders = async () =>
  (
    await q<{ from_id: string }>(
      `select from_id from links where link_type = 'assigned_to' and to_type = 'playbook' and to_id = $1`,
      [PLAYBOOK]
    )
  ).rows.map((r) => r.from_id);

describe("setAgentAssignment", () => {
  it("one agent per target: assigning B replaces A", async () => {
    const target = { type: "playbook" as const, id: PLAYBOOK };
    await setAgentAssignment({ callerId: OWNER, agentUserId: A, target, assigned: true });
    expect(await holders()).toEqual([A]);
    const r = await setAgentAssignment({ callerId: OWNER, agentUserId: B, target, assigned: true });
    expect(r.replaced).toEqual([A]);
    expect(await holders()).toEqual([B]);
  });

  it("removing drops only this agent's edge", async () => {
    const target = { type: "playbook" as const, id: PLAYBOOK };
    await setAgentAssignment({ callerId: OWNER, agentUserId: A, target, assigned: false });
    expect(await holders()).toEqual([B]);
    await setAgentAssignment({ callerId: OWNER, agentUserId: B, target, assigned: false });
    expect(await holders()).toEqual([]);
  });

  it("someone else's agent is refused unless they are a pod admin", async () => {
    const target = { type: "playbook" as const, id: PLAYBOOK };
    await expect(
      setAgentAssignment({ callerId: STRANGER, agentUserId: A, target, assigned: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await holders()).toEqual([]);
    h.admin = true;
    try {
      await setAgentAssignment({ callerId: STRANGER, agentUserId: A, target, assigned: true });
      expect(await holders()).toEqual([A]);
    } finally {
      h.admin = false;
      await q(`delete from links`);
    }
  });

  it("a target the person cannot see is refused, nothing written", async () => {
    h.visible = false;
    try {
      await expect(
        setAgentAssignment({
          callerId: OWNER,
          agentUserId: A,
          target: { type: "playbook", id: PLAYBOOK },
          assigned: true,
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await holders()).toEqual([]);
    } finally {
      h.visible = true;
    }
  });
});

describe("setAgentAssignment — per owner", () => {
  it("a teammate's assignment on a shared target stays", async () => {
    const target = { type: "playbook" as const, id: PLAYBOOK };
    await setAgentAssignment({ callerId: STRANGER, agentUserId: THEIRS, target, assigned: true });
    await setAgentAssignment({ callerId: OWNER, agentUserId: A, target, assigned: true });
    expect((await holders()).sort()).toEqual([A, THEIRS].sort());
    // Re-assigning replaces only the owner's own agent.
    await setAgentAssignment({ callerId: OWNER, agentUserId: B, target, assigned: true });
    expect((await holders()).sort()).toEqual([B, THEIRS].sort());
    await q(`delete from links`);
  });
});

describe("setAgentPaused", () => {
  it("pauses with who, resumes clearing both", async () => {
    const paused = await setAgentPaused({ callerId: OWNER, agentUserId: A, paused: true });
    expect(paused.pausedAt).not.toBeNull();
    const [row] = (
      await q<{ agent_paused_at: unknown; agent_paused_by: string | null }>(
        `select agent_paused_at, agent_paused_by from users where id = $1`,
        [A]
      )
    ).rows;
    expect(row!.agent_paused_at).not.toBeNull();
    expect(row!.agent_paused_by).toBe(OWNER);
    await setAgentPaused({ callerId: OWNER, agentUserId: A, paused: false });
    const [after] = (
      await q<{ agent_paused_at: unknown; agent_paused_by: string | null }>(
        `select agent_paused_at, agent_paused_by from users where id = $1`,
        [A]
      )
    ).rows;
    expect(after).toEqual({ agent_paused_at: null, agent_paused_by: null });
  });

  it("a stranger cannot pause someone's agent", async () => {
    await expect(
      setAgentPaused({ callerId: STRANGER, agentUserId: A, paused: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
