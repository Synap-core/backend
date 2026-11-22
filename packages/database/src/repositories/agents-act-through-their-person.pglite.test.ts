/**
 * An agent is never a space or project member: it acts through its person's
 * membership (decision 2). Proved on PGlite through the gate's membership
 * step (`verifyPermission` → `getMembership` → `membershipHolderIds`), the
 * person removal door (`WorkspaceMemberRepository.remove`) and migration
 * 0450: a removed person's agent loses the space on every path, a seat an
 * agent still holds grants nothing, an agent acts for the person its key is
 * linked to (never its creator when they differ), and a shared agent (no
 * linked key) acts for the person who installed it. Cannot see: production
 * Postgres, the read floor's `db` (`memberWorkspaceIds` shares the subquery).
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
import {
  getProjectMembership,
  verifyPermission,
} from "../utils/permissions.js";

const M0450 = readFileSync(
  fileURLToPath(
    new URL(
      "../../migrations/0450_agents_hold_no_membership.sql",
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
const PROJECT = randomUUID();
const ADMIN = "admin-agents";
const POD_OWNER = "pod-owner-agents";
const PERSON = "person-agents";
const STAYER = "stayer-agents";
// Agents acting for one person (a key linked to them).
const PERSON_AGENT = randomUUID();
const PERSON_REVOKED_AGENT = randomUUID(); // its only key is revoked
const STAYER_AGENT = randomUUID();
const OWNER_MADE_FOR_STAYER = randomUUID(); // created by POD_OWNER, acts for STAYER
// Shared agents: installed by the pod owner, no key linked to a person.
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
    "delete from workspace_members; delete from project_members; delete from proposals; delete from users; delete from automations; delete from api_keys;"
  );
  await q(
    `insert into users (id, email, user_type) values
       ($1, 'admin@x.test', 'human'), ($2, 'o@x.test', 'human'),
       ($3, 'p@x.test', 'human'), ($4, 's@x.test', 'human')`,
    [ADMIN, POD_OWNER, PERSON, STAYER]
  );
  const agents: Array<[string, string | null, string]> = [
    [PERSON_AGENT, PERSON, "cli"],
    [PERSON_REVOKED_AGENT, POD_OWNER, "cli"],
    [STAYER_AGENT, STAYER, "cli"],
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
  await key(OWNER_MADE_FOR_STAYER, STAYER);
  await key(POD_WIDE, null);
});

describe("a removed person's agent loses the space on every path", () => {
  beforeEach(async () => {
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, PERSON);
    await member(SPACE, STAYER);
    await member(OTHER_SPACE, PERSON);
  });

  it("passes the write gate through its person's membership, with no seat of its own", async () => {
    expect(await memberIds(SPACE)).not.toContain(PERSON_AGENT);
    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(true);
  });

  it("fails it once the person is removed, and the removal names only the person", async () => {
    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(await canWrite(PERSON, SPACE)).toBe(false);
    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(false);
    expect(events.map((e) => e.subjectId)).toEqual([PERSON]);
  });

  it("a seat the agent still holds grants nothing (enrolment, a join, an app sync)", async () => {
    await member(SPACE, PERSON_AGENT, "admin");
    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(await canWrite(PERSON_AGENT, SPACE)).toBe(false);
  });

  it("a revoked key still names its person, never falls back to the creator", async () => {
    await member(SPACE, POD_OWNER);
    expect(await canWrite(PERSON_REVOKED_AGENT, SPACE)).toBe(true);

    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(await canWrite(PERSON_REVOKED_AGENT, SPACE)).toBe(false);
  });

  it("CONTROL: another member's agent, and the person's agent in another space, keep their access", async () => {
    await repo.remove({ workspaceId: SPACE, userId: PERSON }, ADMIN);

    expect(await canWrite(STAYER_AGENT, SPACE)).toBe(true);
    expect(await canWrite(PERSON_AGENT, OTHER_SPACE)).toBe(true);
  });
});

describe("whose membership an agent acts through", () => {
  it("the person its key is linked to, not the person who created it", async () => {
    await member(SPACE, POD_OWNER);
    await member(SPACE, STAYER);
    expect(await canWrite(OWNER_MADE_FOR_STAYER, SPACE)).toBe(true);

    await repo.remove({ workspaceId: SPACE, userId: STAYER }, POD_OWNER);

    expect(await canWrite(OWNER_MADE_FOR_STAYER, SPACE)).toBe(false);
  });

  it("a shared agent (no linked key) acts through the person who installed it", async () => {
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, POD_OWNER);
    for (const shared of [CAPTURE, PERSONA, POD_WIDE]) {
      expect(await canWrite(shared, SPACE)).toBe(true);
    }

    await repo.remove({ workspaceId: SPACE, userId: POD_OWNER }, ADMIN);

    for (const shared of [CAPTURE, PERSONA, POD_WIDE]) {
      expect(await canWrite(shared, SPACE)).toBe(false);
    }
  });

  it("an agent nobody owns acts through no one", async () => {
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, ORPHAN_AGENT, "owner");

    expect(await canWrite(ORPHAN_AGENT, SPACE)).toBe(false);
  });

  it("a project role is the person's too", async () => {
    await q(
      `insert into project_members (id, project_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), PROJECT, PERSON_AGENT]
    );
    expect(await getProjectMembership(db, [PROJECT], PERSON_AGENT)).toBe(null);

    await q(
      `insert into project_members (id, project_id, user_id, role) values ($1, $2, $3, 'viewer')`,
      [randomUUID(), PROJECT, PERSON]
    );
    expect(await getProjectMembership(db, [PROJECT], PERSON_AGENT)).toEqual({
      role: "viewer",
      projectId: PROJECT,
    });
  });
});

describe("migration 0450", () => {
  const JOIN = randomUUID();
  const OTHER = randomUUID();

  beforeEach(async () => {
    await member(SPACE, ADMIN, "owner");
    await member(SPACE, PERSON);
    for (const agent of [PERSON_AGENT, CAPTURE, POD_WIDE, ORPHAN_AGENT]) {
      await member(SPACE, agent);
    }
    await q(
      `insert into project_members (id, project_id, user_id, role) values ($1, $2, $3, 'editor'), ($4, $2, $5, 'editor')`,
      [randomUUID(), PROJECT, PERSON_AGENT, randomUUID(), PERSON]
    );
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, workspace_id, agent_user_id, data)
       values ($1, 'pending', 'workspace', $3, 'join', $3, $4, '{"role":"editor"}'::jsonb),
              ($2, 'pending', 'entity', $3, 'create', $3, $4, '{}'::jsonb)`,
      [JOIN, OTHER, SPACE, PERSON_AGENT]
    );
  });

  it("deletes every agent membership, keeps the persons', and ends pending joins as expired", async () => {
    await client.exec(M0450);

    expect(await memberIds(SPACE)).toEqual([ADMIN, PERSON].sort());
    expect(
      (
        await q<{ user_id: string }>(
          `select user_id from project_members where project_id = $1`,
          [PROJECT]
        )
      ).map((r) => r.user_id)
    ).toEqual([PERSON]);
    const rows = await q<{ id: string; status: string; data: unknown }>(
      `select id, status, data from proposals order by id`
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(JOIN)?.status).toBe("expired");
    expect(byId.get(JOIN)?.data).toMatchObject({
      role: "editor",
      ended: { reason: "lapsed", by: "system" },
    });
    expect(byId.get(OTHER)?.status).toBe("pending");
  });

  it("is idempotent", async () => {
    await client.exec(M0450);
    const once = await memberIds(SPACE);
    await client.exec(M0450);

    expect(await memberIds(SPACE)).toEqual(once);
  });
});
