/**
 * The Job door (0395, plan "Computer once, agents inside" §10 test 8) on
 * PGlite with 0395's unique index: it sets an agent's job, name and (for an
 * agent made before seats) its OS user IN PLACE — same id, same key — refuses
 * a combination another agent holds, refuses moving a seated agent to another
 * OS user, and refuses every key (person-only, signed in).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { setAgentJob } from "./agent-job.js";

const HUMAN = "human-job";
const OTHER = "human-job-other";
const MACHINE = "machine-job-devbox";
const CRM = "agent-job-crm"; // like 7455fd94: no seat, no job
const DEV = "agent-job-dev"; // the dev worker, already seated + jobbed

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "../../../database/migrations/0395_agents_inside_a_computer.sql"
);

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.hasDefault &&
            c.default !== undefined &&
            typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : c.default}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const agentRow = async (id: string) =>
  (
    await q<{
      name: string;
      agent_role: string | null;
      host_seat: string | null;
    }>(`select name, agent_role, host_seat from users where id = $1`, [id])
  )[0]!;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  if (existsSync(MIGRATION)) {
    const index = readFileSync(MIGRATION, "utf8").match(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_identity_unique[\s\S]*?;/
    );
    if (index) await h.client!.exec(index[0]);
  }
  for (const id of [HUMAN, OTHER])
    await q(
      `insert into users (id, email, user_type, email_verified, timezone, locale, is_personal_agent)
       values ($1, $1 || '@x', 'human', true, 'UTC', 'en', false)`,
      [id]
    );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, email_verified, timezone, locale, is_personal_agent)
     values ($1, $1 || '@x', 'devbox', 'agent', 'machine', $2, true, 'UTC', 'en', false)`,
    [MACHINE, HUMAN]
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, host_seat, agent_role, email_verified, timezone, locale, is_personal_agent)
     values ($1, $1 || '@x', 'Claude Code', 'agent', 'claude-code', $2, $3, null, null, true, 'UTC', 'en', false),
            ($4, $4 || '@x', 'Dev worker', 'agent', 'claude-code', $2, $3, 'antoine', 'dev-worker', true, 'UTC', 'en', false)`,
    [CRM, HUMAN, MACHINE, DEV]
  );
  await q(
    `insert into api_keys (user_id, key_name, key_prefix, key_hash, key_type, scope, is_active)
     values ($1, 'crm', 'synap_hub_live_', 'hash-crm', 'hub_inbound', '{}', true)`,
    [CRM]
  );
}, 120_000);

describe("the Job door", () => {
  it("sets the job, name and seat of an agent made before seats — in place, keys kept", async () => {
    const res = await setAgentJob({
      callerId: HUMAN,
      agentUserId: CRM,
      role: "crm-worker",
      label: "CRM worker",
      seat: "antoine",
    });
    expect(res).toEqual({
      agentUserId: CRM,
      role: "crm-worker",
      name: "CRM worker",
      seat: "antoine",
    });
    expect(await agentRow(CRM)).toEqual({
      name: "CRM worker",
      agent_role: "crm-worker",
      host_seat: "antoine",
    });
    const keys = await q<{ revoked_at: Date | null }>(
      `select revoked_at from api_keys where user_id = $1`,
      [CRM]
    );
    expect(keys).toEqual([{ revoked_at: null }]);
  });

  it("refuses a combination another agent already holds", async () => {
    await expect(
      setAgentJob({
        callerId: HUMAN,
        agentUserId: CRM,
        role: "dev-worker",
        label: "Dev worker",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await agentRow(CRM)).agent_role).toBe("crm-worker");
  });

  it("refuses moving a seated agent to another OS user", async () => {
    await expect(
      setAgentJob({
        callerId: HUMAN,
        agentUserId: DEV,
        role: "dev-worker",
        seat: "agent",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await agentRow(DEV)).host_seat).toBe("antoine");
  });

  it("refuses a job that is not a slug, and someone else's agent", async () => {
    await expect(
      setAgentJob({ callerId: HUMAN, agentUserId: DEV, role: "Dev Worker!" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setAgentJob({ callerId: OTHER, agentUserId: DEV, role: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses every key: an agent's key, a computer key, a person's own key", async () => {
    const { agentUsersRouter } = await import("../routers/agent-users.js");
    const input = {
      agentUserId: "00000000-0000-4000-8000-000000000001",
      role: "crm-worker",
    };
    for (const keyCtx of [
      { agentUserId: CRM, keyType: "hub_inbound" },
      { agentUserId: MACHINE, keyType: "user_pat" },
      { keyType: "user_pat" },
    ]) {
      const caller = agentUsersRouter.createCaller({
        db: h.db,
        authenticated: true,
        userId: HUMAN,
        session: { id: "s" },
        ...keyCtx,
      } as never);
      await expect(caller.setJob(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });
});
