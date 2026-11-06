/**
 * Synap account agents have their own identity (review bf96d410 of the
 * connect wave, lane B; founder decision 4 of 4 Nov 2026), on PGlite with
 * 0395's unique index and 0400's migration applied from their files.
 *
 * The defect: an agent `/mcp/redeem` minted (no computer, no seat) was the
 * same row `/setup/agent` finds for a person's key, and the one a computer
 * adopts as "made before computers". A computer-less ChatGPT behind the
 * Synap account could so be moved onto a computer, or share an agent with a
 * `synap connect` of the same type. Pinned:
 *   1. 0400 backfills the origin of the keys the connector holds (and only
 *      those) and moves their agents onto the Synap account seat; every key
 *      stays live and held by the same agent;
 *   2. after it, a person's `/setup/agent` (no computer) and a computer's
 *      (adoption) never land on the Synap account agent;
 *   3. an agent holding a Synap account key is never adopted, even with no
 *      seat yet (the adoption guard, independent of the backfill);
 *   4. the redeem shape (seat + origin) reuses its own agent and stamps the
 *      key's origin.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
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
import { SYNAP_ACCOUNT_SEAT } from "@synap-core/types/agents";
import {
  findOrCreateServiceAgentUser,
  provisionSurfaceAgentKey,
} from "./agent-identity-service.js";
import { SYNAP_ACCOUNT_KEY_ORIGIN } from "./synap-account-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, "../../../database/migrations");

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

/** 0400 as shipped, minus the ALTER (the schema DDL above has the column). */
async function runMigration0400() {
  const sql = readFileSync(
    join(MIGRATIONS, "0400_synap_account_key_origin.sql"),
    "utf8"
  );
  await h.client!.exec(sql);
}

let n = 0;
async function agent(
  creator: string,
  agentType: string,
  over: { hostUserId?: string | null; hostSeat?: string | null } = {}
): Promise<string> {
  const id = `agent-${agentType}-${++n}`;
  await q(
    `insert into users (id, email, user_type, email_verified, timezone, locale,
       is_personal_agent, agent_type, created_by_user_id, host_user_id, host_seat)
     values ($1, $1 || '@synap.agent', 'agent', true, 'UTC', 'en', false, $2, $3, $4, $5)`,
    [id, agentType, creator, over.hostUserId ?? null, over.hostSeat ?? null]
  );
  return id;
}

async function key(
  userId: string,
  instanceId: string | null,
  origin: string | null = null
): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into api_keys (user_id, key_name, key_prefix, key_hash, key_type, scope,
       is_active, instance_id, origin)
     values ($1, 'k', 'synap_hub_live_', gen_random_uuid()::text, 'hub_inbound',
       '{hub-protocol.read}', true, $2, $3)
     returning id`,
    [userId, instanceId, origin]
  );
  return rows[0]!.id;
}

const userRow = async (id: string) =>
  (
    await q<{ host_user_id: string | null; host_seat: string | null }>(
      `select host_user_id, host_seat from users where id = $1`,
      [id]
    )
  )[0]!;

const originOf = async (keyId: string) =>
  (
    await q<{
      origin: string | null;
      revoked_at: Date | null;
      user_id: string;
    }>(`select origin, revoked_at, user_id from api_keys where id = $1`, [
      keyId,
    ])
  )[0]!;

async function human(id: string) {
  await q(
    `insert into users (id, email, user_type, email_verified, timezone, locale, is_personal_agent)
     values ($1, $1 || '@x', 'human', true, 'UTC', 'en', false)`,
    [id]
  );
}

/** The person's ONE computer: what adoption needs to move an agent. */
async function computer(creator: string): Promise<string> {
  const id = `machine-${++n}`;
  await q(
    `insert into users (id, email, user_type, email_verified, timezone, locale,
       is_personal_agent, agent_type, created_by_user_id)
     values ($1, $1 || '@synap.agent', 'agent', true, 'UTC', 'en', false, 'machine', $2)`,
    [id, creator]
  );
  return id;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  const m0395 = readFileSync(
    join(MIGRATIONS, "0395_agents_inside_a_computer.sql"),
    "utf8"
  );
  const index = m0395.match(
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_identity_unique[\s\S]*?;/
  );
  if (!index) throw new Error("0395's identity index not found");
  await h.client!.exec(index[0]);
}, 120_000);

describe("1. 0400 backfills the connector's keys and moves their agents to the account seat", () => {
  it("only the connector's keys get the origin; their agents the seat; every key stays live", async () => {
    const P = "person-backfill";
    await human(P);
    const chatgpt = await agent(P, "chatgpt");
    const chatgptKey = await key(chatgpt, "mcp:cp-user:pod-1:chatgpt");
    const legacyWeb = await agent(P, "claude-web");
    const legacyKey = await key(legacyWeb, null); // pre-W5, no instance
    const local = await agent(P, "claude-code");
    const localKey = await key(local, "devbox-3f9a");
    const direct = await agent(P, "claude-web-direct");
    const directKey = await key(direct, "oauth:client-a:person-backfill");

    await runMigration0400();
    await runMigration0400(); // re-runnable

    expect((await originOf(chatgptKey)).origin).toBe(SYNAP_ACCOUNT_KEY_ORIGIN);
    expect((await originOf(legacyKey)).origin).toBe(SYNAP_ACCOUNT_KEY_ORIGIN);
    expect((await originOf(localKey)).origin).toBeNull();
    expect((await originOf(directKey)).origin).toBeNull();

    expect((await userRow(chatgpt)).host_seat).toBe(SYNAP_ACCOUNT_SEAT);
    expect((await userRow(legacyWeb)).host_seat).toBe(SYNAP_ACCOUNT_SEAT);
    expect((await userRow(local)).host_seat).toBeNull();
    expect((await userRow(direct)).host_seat).toBeNull();

    // Existing live keys keep working: same holder, nothing revoked.
    for (const [k, holder] of [
      [chatgptKey, chatgpt],
      [legacyKey, legacyWeb],
    ] as const) {
      const row = await originOf(k);
      expect(row.revoked_at).toBeNull();
      expect(row.user_id).toBe(holder);
    }
  });
});

describe("2. after 0400, no other door lands on the Synap account agent", () => {
  it("a person's /setup/agent (no computer) gets its own agent", async () => {
    const P = "person-setup";
    await human(P);
    const account = await agent(P, "chatgpt");
    await key(account, "mcp:cp-user:pod-1:chatgpt");
    await runMigration0400();

    const got = await findOrCreateServiceAgentUser({
      creatorId: P,
      agentType: "chatgpt",
      label: "ChatGPT",
      hostUserId: null,
    });
    expect(got.agentUserId).not.toBe(account);
    expect((await userRow(account)).host_user_id).toBeNull();
  });

  it("a computer's /setup/agent never adopts it onto the computer", async () => {
    const P = "person-adopt";
    await human(P);
    const account = await agent(P, "cursor");
    await key(account, "mcp:cp-user:pod-1:cursor");
    await runMigration0400();
    const machine = await computer(P);

    const got = await findOrCreateServiceAgentUser({
      creatorId: P,
      agentType: "cursor",
      label: "Cursor",
      hostUserId: machine,
    });
    expect(got.agentUserId).not.toBe(account);
    expect(await userRow(account)).toEqual({
      host_user_id: null,
      host_seat: SYNAP_ACCOUNT_SEAT,
    });
  });
});

describe("3. a Synap account key holder is never adopted, seat or not", () => {
  it("an agent with no seat yet but a Synap account key stays off the computer", async () => {
    const P = "person-guard";
    await human(P);
    // No backfill here: the adoption guard alone must hold.
    const account = await agent(P, "codex");
    await key(account, "mcp:cp-user:pod-1:codex", SYNAP_ACCOUNT_KEY_ORIGIN);
    const machine = await computer(P);

    const got = await findOrCreateServiceAgentUser({
      creatorId: P,
      agentType: "codex",
      label: "Codex",
      hostUserId: machine,
    });
    expect(got.agentUserId).not.toBe(account);
    expect((await userRow(account)).host_user_id).toBeNull();
  });

  it("control: a computer-less agent with only a local key IS adopted (Q-D2 unchanged)", async () => {
    const P = "person-control";
    await human(P);
    const old = await agent(P, "codex");
    await key(old, "devbox-old");
    const machine = await computer(P);

    const got = await findOrCreateServiceAgentUser({
      creatorId: P,
      agentType: "codex",
      label: "Codex",
      hostUserId: machine,
    });
    expect(got.agentUserId).toBe(old);
    expect((await userRow(old)).host_user_id).toBe(machine);
  });
});

describe("4. the redeem shape: its own agent, its key stamped", () => {
  it("two redeems for one client reuse one agent on the account seat, each key with the origin", async () => {
    const P = "person-redeem";
    await human(P);
    // A local agent of the same type exists: the redeem must not take it.
    const local = await agent(P, "chatgpt");
    const redeem = () =>
      provisionSurfaceAgentKey({
        agentType: "chatgpt",
        createdByUserId: P,
        linkedUserId: P,
        hostUserId: null,
        hostSeat: SYNAP_ACCOUNT_SEAT,
        instanceId: "mcp:cp-user:pod-1:chatgpt",
        keyOrigin: SYNAP_ACCOUNT_KEY_ORIGIN,
        agentLabel: "ChatGPT via Synap account",
      });
    const first = await redeem();
    const second = await redeem();
    expect(first.agentUserId).not.toBe(local);
    expect(second.agentUserId).toBe(first.agentUserId);
    expect((await userRow(first.agentUserId)).host_seat).toBe(
      SYNAP_ACCOUNT_SEAT
    );
    if (first.alreadyValid || second.alreadyValid)
      throw new Error("redeem never short-circuits");
    expect((await originOf(second.keyId)).origin).toBe(
      SYNAP_ACCOUNT_KEY_ORIGIN
    );
  });
});
