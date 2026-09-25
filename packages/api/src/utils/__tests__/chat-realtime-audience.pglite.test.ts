/**
 * Chat content reaches EXACTLY the channel's readers — on a real Postgres
 * (PGlite), through the real emit door (`emitChatEvent`) and the real read
 * predicate (`channelVisibilityWhere`), never a hand-built audience.
 *
 * The defect this pins: every `chat:message` / `chat:stream` was POSTed to the
 * realtime bridge with `workspaceId`, and the bridge fans a `workspaceId` out to
 * `workspace:<id>` — every socket of every workspace member. A roster-only
 * session room (and a private thread) therefore streamed to members the read
 * rule hides it from, while a roster human who is not in the workspace got no
 * live message at all.
 *
 * Socket model (mirrors `@synap/realtime`): a user's socket sits in
 * `user:<id>` always and `workspace:<ws>` for each workspace it is a member
 * of (handshake); it is in `channel:<id>` only if it JOINED that room
 * (`useChannelStream` joins the room it displays; the join gate is the same
 * predicate — covered in `@synap/realtime` `room-authz`). A bridge body reaches
 * the union of `channel:` / `workspace:` / `user:` rooms it names.
 *
 * NOT covered, measured: the bridge's own room fan-out (bridge.ts) — this test
 * reads the bodies the door POSTs and applies that fan-out rule itself.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});
// Webhook fan-out is a separate transport; keep it inert here.
vi.mock("../webhook-delivery.js", () => ({
  dispatchWebhooksForEvent: () => undefined,
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { emitChatEvent } from "../chat-realtime-broadcast.js";

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

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this door reads.
      }
    }
  }
}, 120_000);

// ── bridge capture ──────────────────────────────────────────────────────────
type BridgeBody = {
  event: string;
  data: unknown;
  workspaceId?: string;
  userId?: string;
  channelId?: string;
};
let bodies: BridgeBody[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  bodies = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body)) as BridgeBody);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await h.client!.exec(
    `delete from channel_members; delete from channels;
     delete from workspace_members; delete from workspaces; delete from users;`
  );
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── seed ────────────────────────────────────────────────────────────────────
async function seedUser(id: string) {
  await q(
    `insert into users (id, email, user_type) values ($1, $1 || '@test', 'human')`,
    [id]
  );
}
async function seedWorkspace(ownerId: string, memberIds: string[]) {
  const id = randomUUID();
  await q(`insert into workspaces (id, owner_id, name) values ($1, $2, 'W')`, [
    id,
    ownerId,
  ]);
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

// ── socket model ────────────────────────────────────────────────────────────
type Socket = { userId: string; workspaces: string[]; joined: string[] };

/** Rooms a bridge body is delivered to (bridge.ts handleEmit). */
function roomsOf(b: BridgeBody): string[] {
  return [
    ...(b.channelId ? [`channel:${b.channelId}`] : []),
    ...(b.workspaceId ? [`workspace:${b.workspaceId}`] : []),
    ...(b.userId ? [`user:${b.userId}`] : []),
  ];
}
function socketRooms(s: Socket): string[] {
  return [
    `user:${s.userId}`,
    ...s.workspaces.map((w) => `workspace:${w}`),
    ...s.joined.map((c) => `channel:${c}`),
  ];
}
/** Did `socket` receive `event` carrying content of `channelId`? */
function received(socket: Socket, event: string): boolean {
  const mine = new Set(socketRooms(socket));
  return bodies
    .filter((b) => b.event === event)
    .some((b) => roomsOf(b).some((r) => mine.has(r)));
}
async function settle() {
  // The door is fire-and-forget; wait until its background POSTs land.
  await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0), {
    timeout: 3000,
  });
  await new Promise((r) => setTimeout(r, 50));
}

const OWNER = randomUUID();
const ROSTER_OUTSIDER = randomUUID(); // on the room's roster, NOT in its workspace
const WS_MEMBER = randomUUID(); // in the workspace, NOT on the roster

async function world() {
  for (const u of [OWNER, ROSTER_OUTSIDER, WS_MEMBER]) await seedUser(u);
  const ws = await seedWorkspace(OWNER, [OWNER, WS_MEMBER]);
  return ws;
}

function chatMessage(channelId: string, workspaceId: string | null) {
  // The shape `send-message.ts` / `post-message.ts` emit today.
  emitChatEvent({
    event: "chat:message",
    data: {
      threadId: channelId,
      channelId,
      message: { id: randomUUID(), content: "secret plan", role: "user" },
    },
    workspaceId,
    userId: OWNER,
    channelId,
  });
}
function chatStream(channelId: string, workspaceId: string | null) {
  emitChatEvent({
    event: "chat:stream",
    data: { threadId: channelId, channelId, chunk: "secret plan" },
    workspaceId,
    userId: OWNER,
    channelId,
  });
}

describe("chat content → only the channel's readers", () => {
  it("session room: a workspace member off the roster receives NOTHING; the roster outsider receives chat:message without joining", async () => {
    const ws = await world();
    const room = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "group",
      context: "focus_session",
      roster: [OWNER, ROSTER_OUTSIDER],
    });

    chatMessage(room, ws);
    chatStream(room, ws);
    await settle();

    const nonRoster: Socket = {
      userId: WS_MEMBER,
      workspaces: [ws],
      joined: [],
    };
    expect(received(nonRoster, "chat:message")).toBe(false);
    expect(received(nonRoster, "chat:stream")).toBe(false);

    // A roster human outside the workspace — NOT joined to the room (a channel
    // list / preview reader) — still gets the durable message…
    const rosterIdle: Socket = {
      userId: ROSTER_OUTSIDER,
      workspaces: [],
      joined: [],
    };
    expect(received(rosterIdle, "chat:message")).toBe(true);
    // …and the stream once the room is open (joined).
    const rosterOpen: Socket = { ...rosterIdle, joined: [room] };
    expect(received(rosterOpen, "chat:stream")).toBe(true);

    // No chat content body names the workspace room at all.
    expect(bodies.filter((b) => b.workspaceId)).toEqual([]);
  });

  it("private thread: a workspace member who is not its owner receives NOTHING", async () => {
    const ws = await world();
    const thread = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "thread",
    });

    chatMessage(thread, ws);
    chatStream(thread, ws);
    await settle();

    const bystander: Socket = {
      userId: WS_MEMBER,
      workspaces: [ws],
      joined: [],
    };
    expect(received(bystander, "chat:message")).toBe(false);
    expect(received(bystander, "chat:stream")).toBe(false);
    const owner: Socket = { userId: OWNER, workspaces: [ws], joined: [] };
    expect(received(owner, "chat:message")).toBe(true);
  });

  it("a channel named only in the PAYLOAD by an actor who cannot read it is not broadcast into (POST /events/broadcast relays caller data)", async () => {
    const ws = await world();
    const room = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "group",
      context: "focus_session",
      roster: [OWNER, ROSTER_OUTSIDER],
    });

    // WS_MEMBER (not a reader) names the room in the payload, both classes.
    emitChatEvent({
      event: "agent:run_start",
      data: { threadId: room, note: "spoof" },
      userId: WS_MEMBER,
      workspaceId: ws,
    });
    emitChatEvent({
      event: "chat:stream",
      data: { threadId: room, chunk: "spoof" },
      userId: WS_MEMBER,
      workspaceId: ws,
    });
    await settle();

    const owner: Socket = { userId: OWNER, workspaces: [ws], joined: [room] };
    expect(received(owner, "agent:run_start")).toBe(false);
    expect(received(owner, "chat:stream")).toBe(false);
    const roster: Socket = {
      userId: ROSTER_OUTSIDER,
      workspaces: [],
      joined: [room],
    };
    expect(received(roster, "agent:run_start")).toBe(false);
    // The actor still hears its own event.
    const actor: Socket = { userId: WS_MEMBER, workspaces: [ws], joined: [] };
    expect(received(actor, "agent:run_start")).toBe(true);
  });

  it("control — a plain shared GROUP channel still reaches every workspace member (the audience is not 'nobody')", async () => {
    const ws = await world();
    const group = await seedChannel({
      owner: OWNER,
      workspaceId: ws,
      type: "group",
    });

    chatMessage(group, ws);
    await settle();

    const member: Socket = { userId: WS_MEMBER, workspaces: [ws], joined: [] };
    expect(received(member, "chat:message")).toBe(true);
    const outsider: Socket = {
      userId: ROSTER_OUTSIDER,
      workspaces: [],
      joined: [],
    };
    expect(received(outsider, "chat:message")).toBe(false);
  });
});
