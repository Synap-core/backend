/**
 * PARITY — `visibleProposalIds` (the batch the trust ladder reads 50 cards
 * with) answers EXACTLY what `assertProposalVisibleTo` (the SSOT single gate)
 * answers, id by id, for every viewer × every proposal shape the gate
 * distinguishes: workspace proposal × {owner, admin, editor, viewer,
 * non-member}; pod-wide × {proposer, agent's creator, stranger}; pod admin on
 * everything; a missing id.
 *
 * A parity guard proves SAMENESS, not correctness — the single gate's own
 * suites own the rule. This makes the batch a mirror that cannot drift.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual, getDb: async () => holder.db };
  Object.defineProperty(mocked, "db", { get: () => holder.db, enumerable: true });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  proposals,
  users,
  workspaces,
  workspaceMembers,
  type db as DatabaseHandle,
} from "@synap/database";
import {
  assertProposalVisibleTo,
  visibleProposalIds,
} from "./proposal-visibility.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean") def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) def = " default now()";
    else if (c.primary && type === "uuid") def = " default gen_random_uuid()";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const WS = "11111111-1111-4111-8111-111111111111";
const ADMIN_WS = "22222222-2222-4222-8222-222222222222";
const VIEWERS = ["owner", "admin", "editor", "viewer", "stranger", "proposer", "creator", "podadmin"];
const AGENT = "agent-1";
const ids: string[] = [];

beforeAll(async () => {
  const client = new PGlite();
  for (const t of [proposals, users, workspaces, workspaceMembers]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  await client.exec(`
    insert into users (id, email, user_type) values
      ${VIEWERS.map((v) => `('${v}', '${v}@x.test', 'human')`).join(", ")};
    insert into users (id, email, user_type, created_by_user_id) values ('${AGENT}', 'a@x.test', 'agent', 'creator');
    insert into workspaces (id, name, owner_id, system_slug) values
      ('${WS}', 'Work', 'owner', null), ('${ADMIN_WS}', 'Pod admin', 'podadmin', 'pod-admin');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${WS}', 'owner', 'owner'), ('${WS}', 'admin', 'admin'),
      ('${WS}', 'editor', 'editor'), ('${WS}', 'viewer', 'viewer'),
      ('${ADMIN_WS}', 'podadmin', 'owner');
  `);
  const shapes: Array<[string | null, string | null, string | null]> = [
    [WS, null, AGENT], // workspace, agent-authored
    [WS, "stranger", null], // workspace, human proposer
    [null, "proposer", null], // pod-wide, proposer = sourceId
    [null, "someone", AGENT], // pod-wide, agent's creator
    [null, "someone", null], // pod-wide, nobody's
  ];
  for (const [ws, sourceId, agent] of shapes) {
    const id = randomUUID();
    ids.push(id);
    await client.query(
      `insert into proposals (id, workspace_id, status, proposal_type, target_type, target_id, data, created_by, agent_user_id)
       values ($1, $2, 'pending', 'create', 'entity', $3, $4::jsonb, 'x', $5)`,
      [id, ws, randomUUID(), JSON.stringify(sourceId ? { sourceId } : {}), agent]
    );
  }
  ids.push(randomUUID()); // a missing id
  holder.db = drizzle(client, {
    schema: { proposals, users, workspaces, workspaceMembers },
  }) as unknown as typeof DatabaseHandle;
});

describe("batch proposal visibility ≡ the single gate", () => {
  it("agrees with assertProposalVisibleTo for every viewer × shape (non-vacuous both ways)", async () => {
    let seen = 0;
    let hidden = 0;
    for (const viewer of VIEWERS) {
      const batch = await visibleProposalIds(ids, viewer);
      for (const id of ids) {
        const single = await assertProposalVisibleTo(id, viewer).then(
          () => true,
          () => false
        );
        expect(batch.has(id), `${viewer} × ${id}`).toBe(single);
        if (single) seen++;
        else hidden++;
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(hidden).toBeGreaterThan(5);
  });
});
