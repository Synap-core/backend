/**
 * `proposals.list({ status: "all", agentOnly: true })` with no workspace lens,
 * called by a MEMBER (no pod-admin role): the read pod-admin Home's "Done for
 * you" card makes. Driven through the REAL `list` procedure on PGlite.
 *
 * What it proves: `agentOnly` only NARROWS the member's user floor
 * (`proposalUserFloor`). Another person's agent work in a space the member is
 * not in never comes back; the member's own agent work does; a person's own
 * (non-agent) request is left out.
 *
 * What it does NOT assert: the floor is spaces, not owners. A teammate's
 * agent work in a space they share, and a pod-wide (NULL-space) row, are
 * visible to any pod reader by design (`userVisibleWhere`); this file neither
 * pins nor forbids that. Nor production Postgres constraints (tables are
 * generated from the Drizzle definitions with no FKs, NOT NULL or enums).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

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
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("@synap/storage", () => ({ storage: {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { proposalsRouter } from "../proposals.js";

const MEMBER = "member-ao";
const OTHER = "other-ao";
const MEMBER_AGENT = "agent-of-member-ao";
const OTHER_AGENT = "agent-of-other-ao";
const SHARED = randomUUID();
const PRIVATE = randomUUID();

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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const ROW = {
  /** The member's own agent, in their space: theirs to see. */
  ownAgent: randomUUID(),
  /** Another person's agent, in a space the member is NOT in. */
  othersPrivateAgent: randomUUID(),
  /** The member's own request, filed by no agent: not an AI receipt. */
  ownPerson: randomUUID(),
};

const listAsMember = (input: Record<string, unknown>) =>
  proposalsRouter
    .createCaller({ db, authenticated: true, userId: MEMBER } as never)
    .list({ status: "all", limit: 50, ...input } as never) as Promise<{
    items: Array<{ id: string }>;
  }>;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type) values
       ($1, 'm@test', 'human'), ($2, 'o@test', 'human'),
       ($3, 'ma@test', 'agent'), ($4, 'oa@test', 'agent')`,
    [MEMBER, OTHER, MEMBER_AGENT, OTHER_AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Shared', $3), ($2, 'Private', $3)`,
    [SHARED, PRIVATE, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       ($1, $4, $5, 'member'), ($2, $4, $6, 'owner'), ($3, $7, $6, 'owner')`,
    [randomUUID(), randomUUID(), randomUUID(), SHARED, MEMBER, OTHER, PRIVATE]
  );
  const rows: Array<[string, string, string | null, string]> = [
    [ROW.ownAgent, SHARED, MEMBER_AGENT, MEMBER],
    [ROW.othersPrivateAgent, PRIVATE, OTHER_AGENT, OTHER],
    [ROW.ownPerson, SHARED, null, MEMBER],
  ];
  for (const [id, ws, agent, by] of rows) {
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, created_by, created_at, updated_at)
       values ($1, $2, 'note', $3, 'create', 'approved', '{}'::jsonb, $4, $5, now(), now())`,
      [id, ws, randomUUID(), agent, by]
    );
  }
}, 120_000);

describe("proposals.list — agentOnly as a member, no lens (Home's Done for you)", () => {
  it("NON-VACUITY: the other person's private agent row exists and is listed for its owner", async () => {
    const { items } = (await proposalsRouter
      .createCaller({ db, authenticated: true, userId: OTHER } as never)
      .list({ status: "all", limit: 50, agentOnly: true } as never)) as {
      items: Array<{ id: string }>;
    };
    expect(items.map((r) => r.id)).toContain(ROW.othersPrivateAgent);
  });

  it("never returns another person's agent work from a space the member is not in", async () => {
    const ids = (await listAsMember({ agentOnly: true })).items.map(
      (r) => r.id
    );
    expect(ids).not.toContain(ROW.othersPrivateAgent);
  });

  it("returns the member's own agent work, and no request filed by a person", async () => {
    const ids = (await listAsMember({ agentOnly: true })).items.map(
      (r) => r.id
    );
    expect(ids).toContain(ROW.ownAgent);
    expect(ids).not.toContain(ROW.ownPerson);
  });
});
