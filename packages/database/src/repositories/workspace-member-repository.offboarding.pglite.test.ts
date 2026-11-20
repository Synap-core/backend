/**
 * Finding 747c485f: removing a person from a space must also end the access of
 * the agents that person operates there. The write gate checks the ACTING
 * agent's own membership (`verifyWorkspaceAccess` in api `permission-check.ts`
 * → `verifyPermission({ userId: agentUserId || userId })`), so an agent whose
 * row outlived its person's kept writing to the space.
 *
 * Proved on PGlite through the REAL door every member removal goes through
 * (`WorkspaceMemberRepository.remove`) and the REAL membership step of the gate
 * (`verifyPermission`):
 *   1. after the person's removal, their agent is refused a write there, its
 *      row is gone and a removal event names it (and the person it left with);
 *   2. CONTROL: another member's agent, and the person's agent in ANOTHER
 *      space, keep their access;
 *   3. migration 0440 deletes the rows earlier removals left behind (an agent
 *      whose person is not a member), keeps an agent whose person is a member
 *      and an agent with no person, and a second run changes nothing.
 *
 * Cannot see: production Postgres, the HTTP door above the gate, the
 * track-space grant branch of `verifyWorkspaceAccess` (its own suite).
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { WorkspaceMemberRepository } from "./workspace-member-repository.js";
import { verifyPermission } from "../utils/permissions.js";

const M0440 = readFileSync(
  fileURLToPath(
    new URL(
      "../../migrations/0440_agent_membership_follows_person.sql",
      import.meta.url
    )
  ),
  "utf8"
);

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function sqlDefault(d: unknown): string {
  if (is(d, SQL)) {
    return (d as SQL).queryChunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : "";
      })
      .join("");
  }
  if (typeof d === "string") return `'${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (d && typeof d === "object") return `'${JSON.stringify(d)}'::jsonb`;
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    const def =
      !c.hasDefault ||
      (c.default !== null &&
        typeof c.default === "object" &&
        !is(c.default, SQL) &&
        !/^json/.test(type))
        ? ""
        : sqlDefault(c.default);
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def ? ` default ${def}` : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const client = new PGlite();
const db = drizzle(client, { schema });
const q = async <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
) => (await client.query<T>(sql, params)).rows;

const SPACE = randomUUID();
const OTHER_SPACE = randomUUID();
const ADMIN = "admin-offboarding";
const PERSON = "person-offboarding";
const STAYER = "stayer-offboarding";
const PERSON_AGENT = randomUUID();
const STAYER_AGENT = randomUUID();
const ORPHAN_AGENT = randomUUID(); // an agent nobody owns (created_by NULL)

const events: Array<Record<string, unknown>> = [];
const repo = new WorkspaceMemberRepository(db, {
  append: async (e: Record<string, unknown>) => {
    events.push(e);
  },
} as never);

async function member(workspaceId: string, userId: string, role = "editor") {
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
    [randomUUID(), workspaceId, userId, role]
  );
}

const canWrite = async (userId: string, workspaceId: string) =>
  (
    await verifyPermission({
      db,
      userId,
      workspace: { id: workspaceId },
      requiredPermission: "write",
    })
  ).allowed;

const memberIds = async (workspaceId: string) =>
  (
    await q<{ user_id: string }>(
      `select user_id from workspace_members where workspace_id = $1 order by user_id`,
      [workspaceId]
    )
  ).map((r) => r.user_id);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await client.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  events.length = 0;
  await client.exec(
    "delete from workspace_members; delete from users; delete from automations;"
  );
  await q(
    `insert into users (id, email, user_type) values
       ($1, 'admin@x.test', 'human'), ($2, 'p@x.test', 'human'), ($3, 's@x.test', 'human')`,
    [ADMIN, PERSON, STAYER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values
       ($1, 'pa@x.test', 'agent', $4), ($2, 'sa@x.test', 'agent', $5), ($3, 'oa@x.test', 'agent', null)`,
    [PERSON_AGENT, STAYER_AGENT, ORPHAN_AGENT, PERSON, STAYER]
  );
});

describe("removing a person from a space removes the agents they operate (finding 747c485f)", () => {
  beforeEach(async () => {
    await member(SPACE, ADMIN, "owner");
    for (const u of [PERSON, PERSON_AGENT, STAYER, STAYER_AGENT]) {
      await member(SPACE, u);
    }
    await member(OTHER_SPACE, PERSON);
    await member(OTHER_SPACE, PERSON_AGENT);
  });

  it("the person's agent no longer passes the write gate in that space", async () => {
    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(true);

    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(await canWrite(PERSON, SPACE)).toBe(false);
    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(false);
    expect(await memberIds(SPACE)).not.toContain(PERSON_AGENT);
  });

  it("CONTROL: another member's agent, and the person's agent in another space, keep their access", async () => {
    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(await canWrite(STAYER_AGENT, SPACE)).toBe(true);
    expect(await canWrite(PERSON_AGENT, OTHER_SPACE)).toBe(true);
  });

  it("leaves one removal event per membership removed, the agent's naming its person", async () => {
    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(
      events.map((e) => ({
        type: e.type,
        subjectId: e.subjectId,
        userId: e.userId,
        data: e.data,
      }))
    ).toEqual([
      {
        type: "workspaceMembers.remove.completed",
        subjectId: PERSON,
        userId: ADMIN,
        data: { workspaceId: SPACE, userId: PERSON },
      },
      {
        type: "workspaceMembers.remove.completed",
        subjectId: PERSON_AGENT,
        userId: ADMIN,
        data: {
          workspaceId: SPACE,
          userId: PERSON_AGENT,
          withPersonUserId: PERSON,
        },
      },
    ]);
  });
});

describe("migration 0440 deletes the agent memberships earlier removals left behind", () => {
  beforeEach(async () => {
    // PERSON was removed before the fix: their agent's row stayed.
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, PERSON_AGENT);
    // STAYER is a member, so is their agent.
    await member(SPACE, STAYER);
    await member(SPACE, STAYER_AGENT);
    // An agent with no person.
    await member(SPACE, ORPHAN_AGENT);
  });

  it("removes the agent whose person is not a member, and only it", async () => {
    await client.exec(M0440);

    expect(await memberIds(SPACE)).toEqual(
      [ADMIN, STAYER, STAYER_AGENT, ORPHAN_AGENT].sort()
    );
    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(false);
  });

  it("is idempotent", async () => {
    await client.exec(M0440);
    const once = await memberIds(SPACE);
    await client.exec(M0440);

    expect(await memberIds(SPACE)).toEqual(once);
  });
});
