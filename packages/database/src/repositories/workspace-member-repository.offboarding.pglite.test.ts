/**
 * Finding 747c485f: removing a person from a space also ends the access of the
 * agents acting FOR them there (`api_keys.linked_user_id`, `agentsActingFor`),
 * never of an agent its creator made for everyone (Capture, IS personas) or for
 * another member. Proved on PGlite through the real door
 * (`WorkspaceMemberRepository.remove`) and the gate's membership step
 * (`verifyPermission`), with controls, and migration 0440's cleanup of rows
 * earlier removals left behind (idempotent). Cannot see: production Postgres.
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
const POD_OWNER = "pod-owner-offboarding";
const PERSON = "person-offboarding";
const STAYER = "stayer-offboarding";
// Agents acting for one person (a key linked to them).
const PERSON_AGENT = randomUUID();
const PERSON_REVOKED_AGENT = randomUUID(); // its only key is revoked
const STAYER_AGENT = randomUUID();
const OWNER_AGENT = randomUUID();
const OWNER_MADE_FOR_STAYER = randomUUID(); // created by POD_OWNER, acts for STAYER
// Shared agents: created by the pod owner, acting for nobody.
const CAPTURE = randomUUID(); // no key (Capture agent shape)
const PERSONA = randomUUID(); // no key (Intelligence Service persona shape)
const POD_WIDE = randomUUID(); // a key with no linked person
const ORPHAN_AGENT = randomUUID(); // no creator, no key

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

async function key(
  agentId: string,
  linkedUserId: string | null,
  revoked = false
) {
  await q(
    `insert into api_keys (id, user_id, linked_user_id, key_name, key_prefix, key_hash, key_type, revoked_at)
     values ($1, $2, $3, 'k', 'synap_hub_live_', 'h', 'hub_inbound', $4)`,
    [
      randomUUID(),
      agentId,
      linkedUserId,
      revoked ? new Date().toISOString() : null,
    ]
  );
}

beforeEach(async () => {
  events.length = 0;
  await client.exec(
    "delete from workspace_members; delete from users; delete from automations; delete from api_keys;"
  );
  await q(
    `insert into users (id, email, user_type) values
       ($1, 'admin@x.test', 'human'), ($2, 'o@x.test', 'human'),
       ($3, 'p@x.test', 'human'), ($4, 's@x.test', 'human')`,
    [ADMIN, POD_OWNER, PERSON, STAYER]
  );
  const agents: Array<[string, string | null, string]> = [
    [PERSON_AGENT, PERSON, "cli"],
    [PERSON_REVOKED_AGENT, PERSON, "cli"],
    [STAYER_AGENT, STAYER, "cli"],
    [OWNER_AGENT, POD_OWNER, "cli"],
    [OWNER_MADE_FOR_STAYER, POD_OWNER, "cli"],
    [CAPTURE, POD_OWNER, "system"],
    [PERSONA, POD_OWNER, "intelligence-service"],
    [POD_WIDE, POD_OWNER, "cli"],
    [ORPHAN_AGENT, null, "system"],
  ];
  for (const [id, createdBy, via] of agents) {
    await q(
      `insert into users (id, email, user_type, created_by_user_id, created_via) values ($1, $2, 'agent', $3, $4)`,
      [id, `${id}@x.test`, createdBy, via]
    );
  }
  await key(PERSON_AGENT, PERSON);
  await key(PERSON_REVOKED_AGENT, PERSON, true);
  await key(STAYER_AGENT, STAYER);
  await key(OWNER_AGENT, POD_OWNER);
  await key(OWNER_MADE_FOR_STAYER, STAYER);
  await key(POD_WIDE, null);
});

describe("removing a person from a space removes the agents acting for them (finding 747c485f)", () => {
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

describe("removing the pod owner from a space keeps the agents that serve every member", () => {
  beforeEach(async () => {
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, STAYER);
    for (const u of [
      POD_OWNER,
      OWNER_AGENT,
      OWNER_MADE_FOR_STAYER,
      CAPTURE,
      PERSONA,
      POD_WIDE,
    ]) {
      await member(SPACE, u);
    }
  });

  it("removes the owner's own agent, and no shared agent", async () => {
    await repo.remove({ workspaceId: SPACE, userId: POD_OWNER }, ADMIN);

    expect(await canWrite(OWNER_AGENT, SPACE)).toBe(false);
    for (const shared of [CAPTURE, PERSONA, POD_WIDE]) {
      expect(await canWrite(shared, SPACE)).toBe(true);
    }
  });

  it("keeps an agent the owner created that acts for another member", async () => {
    await repo.remove({ workspaceId: SPACE, userId: POD_OWNER }, ADMIN);

    expect(await canWrite(OWNER_MADE_FOR_STAYER, SPACE)).toBe(true);
  });
});

describe("migration 0440 deletes the agent memberships earlier removals left behind", () => {
  beforeEach(async () => {
    // PERSON and POD_OWNER are not members of SPACE (PERSON was removed
    // before the fix: their agents' rows stayed).
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, STAYER);
    for (const u of [
      PERSON_AGENT,
      PERSON_REVOKED_AGENT,
      STAYER_AGENT,
      OWNER_MADE_FOR_STAYER,
      CAPTURE,
      PERSONA,
      POD_WIDE,
      ORPHAN_AGENT,
    ]) {
      await member(SPACE, u);
    }
  });

  it("removes the agents acting for a person who is not a member, and only them", async () => {
    await client.exec(M0440);

    expect(await memberIds(SPACE)).toEqual(
      [
        ADMIN,
        STAYER,
        STAYER_AGENT,
        OWNER_MADE_FOR_STAYER,
        CAPTURE,
        PERSONA,
        POD_WIDE,
        ORPHAN_AGENT,
      ].sort()
    );
    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(false);
    expect(await canWrite(PERSON_REVOKED_AGENT, SPACE)).toBe(false);
  });

  it("is idempotent", async () => {
    await client.exec(M0440);
    const once = await memberIds(SPACE);
    await client.exec(M0440);

    expect(await memberIds(SPACE)).toEqual(once);
  });
});
