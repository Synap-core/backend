/**
 * SESSION ROOMS ARE ROSTER-ONLY GROUP ROOMS — on a real Postgres (PGlite),
 * through the real doors, never a hand-built predicate or row.
 *
 *  - LEAK: `channelVisibilityWhere` (the predicate the `channels` VisibilityRule
 *    in `access/registry.ts` delegates to, and the send door reads through)
 *    hides a session GROUP room from a workspace member who is not on its
 *    roster, and a NULL-workspace one from the whole pod. Two plain GROUP
 *    controls prove the broadcast branches are still alive — without them the
 *    "hidden" assertions would pass on a predicate that hides everything.
 *  - MINT: `ensureSessionChannel` mints GROUP + only_mentioned and seeds the
 *    roster (owner + staffed agents + the owner's "@ai") via `enrollRoomMember`.
 *  - ATTACH: `attachSessionAgent` enrolls the agent on the room's roster.
 *  - `enrollRoomMember` is idempotent and never rewrites an existing role.
 *  - MIGRATION 0273, applied from the real .sql file: a minted THREAD session
 *    room becomes GROUP/only_mentioned with its roster backfilled; a BORROWED
 *    thread (no focus_session context stamp) is untouched; re-running is a
 *    no-op.
 *
 * Schema: derived from the drizzle tables (types only). The one constraint the
 * code depends on — `channel_members (channel_id, member_id)` UNIQUE, which
 * every roster `ON CONFLICT` targets — is created explicitly, mirroring
 * `0000_baseline_schema.sql` (`channel_members_channel_member_unique`).
 *
 * NOT covered, measured: the rest of the `access/` layer (`scopedDb`) — the
 * channel rule is `predicate: (access) => channelVisibilityWhere(access.userId)`
 * (registry.ts), so it inherits this predicate; that delegation is not
 * exercised here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { and, inArray } from "drizzle-orm";
import type { db as DatabaseHandle } from "@synap/database";
import * as schema from "@synap/database/schema";
import { channelVisibilityWhere } from "../../../utils/channel-visibility.js";
import { ensureSessionChannel } from "../ensure-session-channel.js";
import { attachSessionAgent } from "../attach-session-agent.js";
import { enrollRoomMember } from "../../messaging/enroll-room-member.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const MIGRATION_0273 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../database/migrations/0273_session_rooms_to_group.sql",
      import.meta.url
    )
  ),
  "utf8"
);

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await h.client!.exec(
    `create unique index if not exists "channel_members_channel_member_unique"
       on "channel_members" ("channel_id", "member_id");`
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from channel_members; delete from channels; delete from focus_sessions;
     delete from workspace_members; delete from workspaces; delete from users;`
  );
});

async function seedUser(
  id: string,
  extra: { agentOf?: string; agentType?: string } = {}
) {
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, is_personal_agent)
     values ($1, $1 || '@test', $2, $3, $4, $5)`,
    [
      id,
      extra.agentOf ? "agent" : "human",
      extra.agentOf ?? null,
      extra.agentType ?? null,
      !!extra.agentOf && extra.agentType === "orchestrator",
    ]
  );
}

async function seedWorkspace(ownerId: string, memberIds: string[]) {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, owner_id, name) values ($1, $2, 'Builder')`,
    [id, ownerId]
  );
  for (const userId of memberIds) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values (gen_random_uuid(), $1, $2, 'editor')`,
      [id, userId]
    );
  }
  return id;
}

async function seedChannel(args: {
  owner: string;
  workspaceId: string | null;
  type: "group" | "thread";
  context?: "focus_session" | null;
  roster?: string[];
}) {
  const id = randomUUID();
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id, ai_reaction_mode)
     values ($1, $2, $3, $4, 'workspace', 'active', 'room', $5, $6, 'when_confident')`,
    [
      id,
      args.owner,
      args.workspaceId,
      args.type,
      args.context ?? null,
      args.context ? randomUUID() : null,
    ]
  );
  for (const member of args.roster ?? []) {
    await q(
      `insert into channel_members (channel_id, member_id, member_kind, role)
       values ($1, $2, 'human', 'member')`,
      [id, member]
    );
  }
  return id;
}

async function seedSession(args: {
  owner: string;
  workspaceId?: string | null;
  agentIds?: string[];
  channelId?: string | null;
}) {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, workspace_id, title, goal, status, origin, channel_id,
        expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, $3, 'Room work', 'Ship rooms', 'active', 'human', $4,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $5, now(), now())`,
    [
      id,
      args.owner,
      args.workspaceId ?? null,
      args.channelId ?? null,
      args.agentIds ?? [],
    ]
  );
  return id;
}

/** Which of `ids` `userId` can see — through the real predicate. */
async function visibleTo(userId: string, ids: string[]): Promise<string[]> {
  const db = (await h.init()) as typeof DatabaseHandle;
  const rows = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(inArray(schema.channels.id, ids), channelVisibilityWhere(userId))
    );
  return rows.map((r) => r.id).sort();
}

const roster = async (channelId: string) =>
  (
    await q<{ member_id: string; member_kind: string; role: string }>(
      `select member_id, member_kind, role from channel_members
       where channel_id = $1 order by member_kind, member_id`,
      [channelId]
    )
  ).rows.map((r) => [r.member_id, r.member_kind, r.role]);

const channelRow = async (id: string) =>
  (
    await q<{
      channel_type: string;
      ai_reaction_mode: string;
      context_object_type: string | null;
    }>(
      `select channel_type, ai_reaction_mode, context_object_type from channels where id = $1`,
      [id]
    )
  ).rows[0]!;

describe("session rooms are ROSTER-ONLY (channelVisibilityWhere)", () => {
  const OWNER = "owner-1";
  const ROSTERED = "rostered-2";
  const BYSTANDER = "bystander-3"; // workspace member, not on the roster
  const POD_USER = "pod-user-4"; // no workspace membership at all

  it("hides a session GROUP room from a non-roster workspace member, shows it to the roster", async () => {
    const ws = await seedWorkspace(OWNER, [OWNER, ROSTERED, BYSTANDER]);
    const sessionRoom = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "group",
      context: "focus_session",
      roster: [ROSTERED],
    });
    // CONTROL: a plain GROUP in the same workspace is still broadcast (branch 3).
    const plainGroup = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "group",
    });
    const ids = [sessionRoom, plainGroup];

    expect(await visibleTo(BYSTANDER, ids)).toEqual([plainGroup]);
    expect(await visibleTo(ROSTERED, ids)).toEqual([...ids].sort());
    expect(await visibleTo(OWNER, ids)).toEqual([...ids].sort());
  });

  it("hides a NULL-workspace session GROUP room from the whole pod", async () => {
    const sessionRoom = await seedChannel({
      owner: OWNER,
      workspaceId: null,
      type: "group",
      context: "focus_session",
      roster: [ROSTERED],
    });
    // CONTROL: a plain pod-wide GROUP is still pod-visible (branch 4).
    const podGroup = await seedChannel({
      owner: OWNER,
      workspaceId: null,
      type: "group",
    });
    const ids = [sessionRoom, podGroup];

    expect(await visibleTo(POD_USER, ids)).toEqual([podGroup]);
    expect(await visibleTo(ROSTERED, ids)).toEqual([...ids].sort());
  });
});

describe("ensureSessionChannel mints a GROUP room with its roster", () => {
  it("GROUP + only_mentioned + roster = owner, staffed agent, owner's @ai", async () => {
    const OWNER = "owner-1";
    const STAFFED = "agent-staffed";
    await seedUser(OWNER);
    await seedUser("orch-1", { agentOf: OWNER, agentType: "orchestrator" });
    const sessionId = await seedSession({ owner: OWNER, agentIds: [STAFFED] });

    const channelId = await ensureSessionChannel({ sessionId, userId: OWNER });

    expect(channelId).toEqual(expect.any(String));
    expect(await channelRow(channelId!)).toEqual({
      channel_type: "group",
      ai_reaction_mode: "only_mentioned",
      context_object_type: "focus_session",
    });
    expect(await roster(channelId!)).toEqual([
      [STAFFED, "ai_agent", "member"],
      ["orch-1", "ai_agent", "member"],
      [OWNER, "human", "owner"],
    ]);
    // …and the room it minted is roster-only: invisible to a stranger.
    expect(await visibleTo("stranger", [channelId!])).toEqual([]);
  });
});

describe("attachSessionAgent enrolls the agent on the room roster", () => {
  it("staffing a session puts the agent on its room's roster (and re-attach heals)", async () => {
    const OWNER = "owner-1";
    const room = await seedChannel({
      owner: OWNER,
      workspaceId: null,
      type: "group",
      context: "focus_session",
    });
    const sessionId = await seedSession({ owner: OWNER, channelId: room });

    const first = await attachSessionAgent({
      sessionId,
      agentId: "agent-x",
      userId: OWNER,
    });
    expect(first).toMatchObject({ status: "attached", added: true });
    expect(await roster(room)).toEqual([["agent-x", "ai_agent", "member"]]);

    // Already on the list, missing from the roster ⇒ the re-attach heals it.
    await q(`delete from channel_members where channel_id = $1`, [room]);
    const again = await attachSessionAgent({
      sessionId,
      agentId: "agent-x",
      userId: OWNER,
    });
    expect(again).toMatchObject({ status: "attached", added: false });
    expect(await roster(room)).toEqual([["agent-x", "ai_agent", "member"]]);
  });
});

describe("enrollRoomMember is idempotent", () => {
  it("a second enroll writes nothing and never rewrites the role", async () => {
    const room = await seedChannel({
      owner: "owner-1",
      workspaceId: null,
      type: "group",
    });
    const db = (await h.init()) as Parameters<typeof enrollRoomMember>[0];
    const params = {
      channelId: room,
      userId: "owner-1",
      memberType: schema.ChannelMemberKind.HUMAN,
      role: schema.ChannelMemberRole.OWNER,
    };
    expect(await enrollRoomMember(db, params)).toBe(true);
    expect(
      await enrollRoomMember(db, {
        ...params,
        role: schema.ChannelMemberRole.MEMBER,
      })
    ).toBe(false);
    expect(await roster(room)).toEqual([["owner-1", "human", "owner"]]);
  });
});

describe("migration 0273 — session THREAD rooms become GROUP rooms", () => {
  it("converts minted session threads, backfills the roster, leaves borrowed threads alone, re-runs as a no-op", async () => {
    const OWNER = "owner-1";
    await seedUser(OWNER);
    await seedUser("orch-1", { agentOf: OWNER, agentType: "orchestrator" });
    const ws = await seedWorkspace(OWNER, [OWNER]);
    const minted = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "thread",
      context: "focus_session",
    });
    await seedSession({ owner: OWNER, channelId: minted, agentIds: ["agt-1"] });
    // A BORROWED thread (a session bound to an existing chat) — no stamp.
    const borrowed = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "thread",
    });
    await seedSession({ owner: OWNER, channelId: borrowed });

    await h.client!.exec(MIGRATION_0273);

    expect(await channelRow(minted)).toMatchObject({
      channel_type: "group",
      ai_reaction_mode: "only_mentioned",
    });
    const expectedRoster = [
      ["agt-1", "ai_agent", "member"],
      ["orch-1", "ai_agent", "member"],
      [OWNER, "human", "owner"],
    ];
    expect(await roster(minted)).toEqual(expectedRoster);
    expect(await channelRow(borrowed)).toMatchObject({
      channel_type: "thread",
      ai_reaction_mode: "when_confident",
    });
    expect(await roster(borrowed)).toEqual([]);

    const countAll = async () =>
      (await q<{ n: number }>(`select count(*)::int as n from channel_members`))
        .rows[0]!.n;
    const before = await countAll();
    await h.client!.exec(MIGRATION_0273);
    expect(await countAll()).toBe(before);
    expect(await roster(minted)).toEqual(expectedRoster);
  });
});
