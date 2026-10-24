/**
 * `join-room` gate for `channel:<id>` — on a real Postgres (PGlite), through the
 * real gate (`canUserJoinRoom`) and the real read predicate it delegates to
 * (`channelVisibilityWhere` in `@synap/database`).
 *
 * The defect this pins: the gate admitted any member of the channel's
 * WORKSPACE, so a workspace member off a roster-only session room's roster (or
 * any member, for a teammate's private thread) could join the room and read its
 * stream; and a roster human who is NOT in the room's workspace was DENIED, so
 * they got no live messages at all.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

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
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { canPrincipalJoinRoom, canUserJoinRoom } from "../room-authz.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def = !c.hasDefault
      ? ""
      : type.endsWith("[]")
        ? " default '{}'"
        : type === "uuid"
          ? " default gen_random_uuid()"
          : type.startsWith("timestamp")
            ? " default now()"
            : typeof c.default === "string"
              ? ` default '${c.default.replace(/'/g, "''")}'`
              : typeof c.default === "number" || typeof c.default === "boolean"
                ? ` default ${c.default}`
                : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this gate reads.
      }
    }
  }
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from channel_members; delete from channels; delete from grants;
     delete from workspace_members; delete from workspaces; delete from users;`
  );
});

const OWNER = randomUUID();
const ROSTER_OUTSIDER = randomUUID(); // on the roster, NOT in the workspace
const WS_MEMBER = randomUUID(); // in the workspace, NOT on the roster

async function world() {
  for (const u of [OWNER, ROSTER_OUTSIDER, WS_MEMBER]) {
    await q(
      `insert into users (id, email, user_type) values ($1, $1 || '@t', 'human')`,
      [u]
    );
  }
  const ws = randomUUID();
  await q(`insert into workspaces (id, owner_id, name) values ($1, $2, 'W')`, [
    ws,
    OWNER,
  ]);
  for (const u of [OWNER, WS_MEMBER]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values (gen_random_uuid(), $1, $2, 'editor')`,
      [ws, u]
    );
  }
  return ws;
}

async function channel(args: {
  ws: string;
  type: "group" | "thread";
  session?: boolean;
  roster?: string[];
}) {
  const id = randomUUID();
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
     values ($1, $2, $3, $4, 'workspace', 'active', 'room', $5, $6)`,
    [
      id,
      OWNER,
      args.ws,
      args.type,
      args.session ? "focus_session" : null,
      args.session ? randomUUID() : null,
    ]
  );
  for (const m of args.roster ?? []) {
    await q(
      `insert into channel_members (channel_id, member_id, member_kind, role)
       values ($1, $2, 'human', 'member')`,
      [id, m]
    );
  }
  return id;
}

describe("canUserJoinRoom('channel:…') = the channel read predicate", () => {
  it("session room: roster outsider may join; workspace member off the roster may NOT", async () => {
    const ws = await world();
    const room = await channel({
      ws,
      type: "group",
      session: true,
      roster: [OWNER, ROSTER_OUTSIDER],
    });
    expect(await canUserJoinRoom(`channel:${room}`, OWNER)).toBe(true);
    expect(await canUserJoinRoom(`channel:${room}`, ROSTER_OUTSIDER)).toBe(
      true
    );
    expect(await canUserJoinRoom(`channel:${room}`, WS_MEMBER)).toBe(false);
  });

  it("private thread: only its owner", async () => {
    const ws = await world();
    const thread = await channel({ ws, type: "thread" });
    expect(await canUserJoinRoom(`channel:${thread}`, OWNER)).toBe(true);
    expect(await canUserJoinRoom(`channel:${thread}`, WS_MEMBER)).toBe(false);
  });

  it("control — a plain shared GROUP channel admits workspace members, not outsiders", async () => {
    const ws = await world();
    const group = await channel({ ws, type: "group" });
    expect(await canUserJoinRoom(`channel:${group}`, WS_MEMBER)).toBe(true);
    expect(await canUserJoinRoom(`channel:${group}`, ROSTER_OUTSIDER)).toBe(
      false
    );
  });

  it("a non-uuid channel id is denied, not thrown", async () => {
    expect(await canUserJoinRoom("channel:not-a-uuid", OWNER)).toBe(false);
  });
});

/**
 * 73a20ec2 — an API-key socket (realtime:observe) used to skip the gate and
 * join ANY room. It now joins what its OWNER may join, narrowed by the key's
 * bound workspace and its grant. OWNER is an editor of A and of B; every key
 * below acts for OWNER, so the owner's check alone would admit B everywhere.
 */
describe("canPrincipalJoinRoom(service) — the key's owner, narrowed to its workspace and grant", () => {
  const AGENT = randomUUID(); // the key's own (agent) user

  async function twoSpaces() {
    const a = await world();
    const b = randomUUID();
    await q(
      `insert into workspaces (id, owner_id, name) values ($1, $2, 'B')`,
      [b, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values (gen_random_uuid(), $1, $2, 'editor')`,
      [b, OWNER]
    );
    return { a, b };
  }

  async function key(args: {
    grants: Array<{ permissions: string[]; workspaceIds?: string[] }>;
    bound?: string;
  }) {
    const apiKeyId = randomUUID();
    for (const g of args.grants) {
      await q(
        `insert into grants (api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
         values ($1, $2, $3, $4::text[], $5::uuid[], $3)`,
        [
          apiKeyId,
          AGENT,
          OWNER,
          `{${g.permissions.join(",")}}`,
          g.workspaceIds ? `{${g.workspaceIds.join(",")}}` : null,
        ]
      );
    }
    return {
      kind: "service" as const,
      apiKeyId,
      userId: AGENT,
      ownerUserId: OWNER,
      workspaceId: args.bound ?? null,
    };
  }

  async function objectRoom(ws: string) {
    const id = randomUUID();
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
       values ($1, $2, $3, 'group', 'workspace', 'active', 'doc', 'document', $4)`,
      [id, OWNER, ws, randomUUID()]
    );
    return id;
  }

  it("a grant pinned to A joins A's workspace and channels — not B's workspace, channel or document room", async () => {
    const { a, b } = await twoSpaces();
    const k = await key({
      grants: [{ permissions: ["*"], workspaceIds: [a] }],
    });
    const chanA = await channel({ ws: a, type: "group" });
    const chanB = await channel({ ws: b, type: "group" });
    const docB = await objectRoom(b);
    // Control: the owner alone may join every one of B's rooms.
    expect(await canUserJoinRoom(`workspace:${b}`, OWNER)).toBe(true);
    expect(await canUserJoinRoom(`channel:${chanB}`, OWNER)).toBe(true);
    expect(await canUserJoinRoom(`channel:${docB}`, OWNER)).toBe(true);

    expect(await canPrincipalJoinRoom(`workspace:${a}`, k)).toBe(true);
    expect(await canPrincipalJoinRoom(`channel:${chanA}`, k)).toBe(true);
    expect(await canPrincipalJoinRoom(`workspace:${b}`, k)).toBe(false);
    expect(await canPrincipalJoinRoom(`channel:${chanB}`, k)).toBe(false);
    expect(await canPrincipalJoinRoom(`channel:${docB}`, k)).toBe(false);
  });

  it("a key BOUND to A (api_keys.workspace_id) with a pod-wide grant joins A only", async () => {
    const { a, b } = await twoSpaces();
    const k = await key({ grants: [{ permissions: ["*"] }], bound: a });
    const chanB = await channel({ ws: b, type: "group" });
    expect(await canPrincipalJoinRoom(`workspace:${a}`, k)).toBe(true);
    expect(await canPrincipalJoinRoom(`workspace:${b}`, k)).toBe(false);
    expect(await canPrincipalJoinRoom(`channel:${chanB}`, k)).toBe(false);
  });

  it("a pod-wide key joins what its owner joins, and no space its owner is not in", async () => {
    const { b } = await twoSpaces();
    const k = await key({ grants: [{ permissions: ["*"] }] });
    const elsewhere = randomUUID();
    await q(
      `insert into workspaces (id, owner_id, name) values ($1, $2, 'C')`,
      [elsewhere, WS_MEMBER]
    );
    expect(await canPrincipalJoinRoom(`workspace:${b}`, k)).toBe(true);
    expect(await canPrincipalJoinRoom(`workspace:${elsewhere}`, k)).toBe(false);
  });

  it("a key with no live grant joins only its own user room — never its owner's", async () => {
    const { a } = await twoSpaces();
    const k = await key({ grants: [] });
    expect(await canPrincipalJoinRoom(`workspace:${a}`, k)).toBe(false);
    expect(await canPrincipalJoinRoom(`user:${AGENT}`, k)).toBe(true);
    expect(await canPrincipalJoinRoom(`user:${OWNER}`, k)).toBe(false);
  });

  it("a channel-only grant reads channels, not the space's whole event feed", async () => {
    const { a } = await twoSpaces();
    const k = await key({ grants: [{ permissions: ["channel.read"] }] });
    const chanA = await channel({ ws: a, type: "group" });
    expect(await canPrincipalJoinRoom(`channel:${chanA}`, k)).toBe(true);
    expect(await canPrincipalJoinRoom(`workspace:${a}`, k)).toBe(false);
  });
});
