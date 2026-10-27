/**
 * F3 (founder, 2026-10-27) — "Approve and allow today". Approving an agent's
 * held-writes pack with `allowToday: true` also lifts that agent's daily write
 * ceiling to 2x the limit in force, until the next 00:00 UTC; the next writes
 * that day are not held; the next UTC day falls back to the base limit; an
 * agent key cannot do it.
 *
 * Real: PGlite, the tRPC proposals router (`approve`, its authority ladder and
 * the allow-today refusal order), `allowAgentForRestOfUtcDay`, the ceiling
 * resolver and the whole agent governance ladder (`resolveAgentGovernanceDecision`,
 * rung 2.56 with its count).
 * Stubbed: `applyProposalApproval` (the replay AFTER the gate — the held-writes
 * replay has its own suite, `ceiling-pack.pglite.test.ts`); `db.transaction`
 * runs its body on the one PGlite connection.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  applied: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db);
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../apply-approval.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    applyProposalApproval: async (args: { proposal: { id: string } }) => {
      h.applied.push(args.proposal.id);
      await h.client!.query(
        `update proposals set status = 'approved' where id = $1`,
        [args.proposal.id]
      );
      return { success: true };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  resolveAgentGovernanceDecision,
  resolveDailyWriteCeiling,
} from "@synap/database/agent-governance";
import { DEFAULT_DAILY_WRITE_CEILING } from "@synap/governance-policy";
import { proposalsRouter } from "../../proposals.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def = c.name === "created_at" ? " default now()" : "";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = randomUUID();
const AGENT = randomUUID();
const POD_ADMIN_WS = randomUUID();
const BASE = DEFAULT_DAILY_WRITE_CEILING;

const human = (userId: string) => ({ authenticated: true, userId }) as never;
const agentKey = (userId: string) =>
  ({ authenticated: true, userId, agentUserId: AGENT }) as never;

async function filePack(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, governance_reason, data, revision_history, created_at, updated_at)
     values ($1, 'pending', 'held_writes', 'agent', $2, null, $2, $2, 'DAILY_WRITE_CEILING', $3::jsonb, '[]'::jsonb, now(), now())`,
    [
      id,
      AGENT,
      JSON.stringify({
        day: new Date().toISOString().slice(0, 10),
        agentUserId: AGENT,
        deferredWrites: [],
        source: "agent",
      }),
    ]
  );
  return id;
}

/** `n` auto-executed agent writes today (rung 2.56's population). */
async function writesToday(n: number): Promise<void> {
  await q(`delete from events`);
  await q(
    `insert into events (id, subject_id, subject_type, type, user_id, data, source, timestamp, is_agent, agent_user_id)
     select gen_random_uuid(), gen_random_uuid(), 'entity', 'entity.create.completed', $1, '{}'::jsonb, 'api', now(), true, $2
     from generate_series(1, $3)`,
    [PERSON, AGENT, n]
  );
}

const nextWrite = async () =>
  resolveAgentGovernanceDecision({
    db: h.db as never,
    agentUserId: AGENT,
    userId: PERSON,
    workspaceId: null,
    subjectType: "entity",
    action: "create",
    preferAgentMetadataAutoApproveFor: true,
  });

const approve = (ctx: never, proposalId: string, allowToday?: boolean) =>
  proposalsRouter
    .createCaller(ctx)
    .approve({ proposalId, ...(allowToday ? { allowToday } : {}) });

const ceilings = () =>
  q<{ limit_value: number; expires_at: string; source_proposal_id: string }>(
    `select limit_value, expires_at, source_proposal_id from governance_ceilings where agent_user_id = $1`,
    [AGENT]
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, user_type) values ($1, 'human')`,
    [PERSON]
  );
  await q(
    `insert into users (id, user_type, created_by_user_id, agent_metadata) values ($1, 'agent', $2, $3::jsonb)`,
    [AGENT, PERSON, JSON.stringify({ autoApproveFor: ["entity.create"] })]
  );
  // PERSON is the pod admin (owner of the pod-admin system space).
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, settings) values ($1, 'Pod admin', $2, 'pod-admin', '{}'::jsonb)`,
    [POD_ADMIN_WS, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), POD_ADMIN_WS, PERSON]
  );
});

beforeEach(async () => {
  h.applied = [];
  await q(`delete from governance_ceilings`);
  await q(`delete from proposals`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("F3 — approve and allow today", () => {
  it("writes an agent ceiling row: 2x the limit in force, expiring at the next 00:00 UTC", async () => {
    const pack = await filePack();
    const out = (await approve(human(PERSON), pack, true)) as {
      allowedToday?: { limit: number; previousLimit: number; expiresAt: string };
    };
    expect(h.applied).toEqual([pack]);
    const now = new Date();
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
    expect(out.allowedToday).toMatchObject({
      limit: 2 * BASE,
      previousLimit: BASE,
      expiresAt: midnight.toISOString(),
    });
    const { rows } = await ceilings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.limit_value).toBe(2 * BASE);
    expect(new Date(rows[0]!.expires_at).toISOString()).toBe(
      midnight.toISOString()
    );
    expect(rows[0]!.source_proposal_id).toBe(pack);
  });

  it("the next writes that day pass; without it they are held", async () => {
    await writesToday(BASE);
    const held = await nextWrite();
    expect(held.decision).toBe("propose");
    expect((held as { reasonCode?: string }).reasonCode).toBe(
      "DAILY_WRITE_CEILING"
    );

    await approve(human(PERSON), await filePack(), true);
    expect((await nextWrite()).decision).toBe("execute");
  });

  it("the next UTC day falls back to the base limit", async () => {
    await approve(human(PERSON), await filePack(), true);
    expect(
      await resolveDailyWriteCeiling({ db: h.db as never, agentUserId: AGENT })
    ).toBe(2 * BASE);
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 1, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(tomorrow);
    expect(
      await resolveDailyWriteCeiling({ db: h.db as never, agentUserId: AGENT })
    ).toBe(BASE);
  });

  it("a plain approve writes no ceiling", async () => {
    await approve(human(PERSON), await filePack());
    expect((await ceilings()).rows).toHaveLength(0);
  });

  it("a second allow-today the same day does not double again", async () => {
    await approve(human(PERSON), await filePack(), true);
    const out = (await approve(human(PERSON), await filePack(), true)) as {
      allowedToday?: { limit: number; alreadyAllowed: boolean };
    };
    expect(out.allowedToday).toMatchObject({
      limit: 2 * BASE,
      alreadyAllowed: true,
    });
    expect((await ceilings()).rows).toHaveLength(1);
  });

  it("an agent key cannot do it (nor approve), and nothing is written", async () => {
    const pack = await filePack();
    await expect(approve(agentKey(PERSON), pack, true)).rejects.toThrow(
      /agent/i
    );
    expect(h.applied).toEqual([]);
    expect((await ceilings()).rows).toHaveLength(0);
  });

  it("refused before approving on a proposal that is not a held-writes pack", async () => {
    const id = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, data, revision_history, created_at, updated_at)
       values ($1, 'pending', 'create', 'entity', $2, null, $3, $3, '{}'::jsonb, '[]'::jsonb, now(), now())`,
      [id, randomUUID(), AGENT]
    );
    await expect(approve(human(PERSON), id, true)).rejects.toThrow(
      /held-writes pack/
    );
    expect(h.applied).toEqual([]);
    expect((await ceilings()).rows).toHaveLength(0);
  });
});
