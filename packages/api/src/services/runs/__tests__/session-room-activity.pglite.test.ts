/**
 * The runs feed's `lastActivityAt` counts a post in the session's own room,
 * by the ONE rule the reapers read (`sessionRoomLastPostAt`, #1383, finding
 * c573d32d), on PGlite. A lane that only reports in its room never moves its
 * session's `updated_at`: the feed read it idle (diagnose's `idle` stall)
 * while the reaper, since #1383, read it worked.
 *
 * Counts: a person's or an agent's post in the session's OWN room. Not: the
 * pod's own notices (`bot`), a coordination post from another session
 * (`sessionPost` stamp), a post in a room that is not the session's.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { listRuns } from "../index.js";

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
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (type === "jsonb" && d && typeof d === "object" && !("queryChunks" in d)) {
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
  const name = cfg.schema ? `"${cfg.schema}"."${cfg.name}"` : `"${cfg.name}"`;
  const pre = cfg.schema ? `create schema if not exists "${cfg.schema}"; ` : "";
  return `${pre}create table if not exists ${name} (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const WS = randomUUID();
const PLAYBOOK = randomUUID();
const MIN = 60_000;

/** An open session, last touched `updatedMinAgo` ago, with its own room. */
async function session(updatedMinAgo: number) {
  const id = randomUUID();
  const room = randomUUID();
  await q(
    `insert into channels (id, context_object_type, context_object_id) values ($1, 'focus_session', $2)`,
    [room, id]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, origin, channel_id, metadata, started_at, updated_at)
     values ($1, $2, $3, 'g', 'active', 'agent', $4, '{}'::jsonb, now() - interval '1 day', now() - make_interval(mins => $5::int))`,
    [id, OWNER, WS, room, updatedMinAgo]
  );
  return { id, room };
}

/** A post in `channelId`, `minAgo` ago. */
async function post(
  channelId: string,
  minAgo: number,
  authorType: string,
  metadata: Record<string, unknown> = {}
) {
  await q(
    `insert into messages (id, channel_id, content, author_type, metadata, timestamp)
     values ($1, $2, 'x', $3, $4::jsonb, now() - make_interval(mins => $5::int))`,
    [randomUUID(), channelId, authorType, JSON.stringify(metadata), minAgo]
  );
}

const minutesAgo = (d: Date | null) =>
  d === null ? null : Math.round((Date.now() - d.getTime()) / MIN);

let reporting: string;
let notices: string;
let touched: string;
let elsewhere: string;
let runSession: string;
let runId: string;

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@x.test', 'O', 'human')`,
    [OWNER]
  );
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );

  // A lane that only reports in its room: touched 5 h ago, posted 10 min ago.
  const a = await session(300);
  await post(a.room, 10, "ai_agent");
  reporting = a.id;
  // Only the pod's notices and a lead's coordination post: not its activity.
  const b = await session(300);
  await post(b.room, 10, "bot");
  await post(b.room, 5, "human", { sessionPost: { from: randomUUID() } });
  notices = b.id;
  // Touched more recently than its last post: the touch wins.
  const c = await session(60);
  await post(c.room, 180, "human");
  touched = c.id;
  // A post in another room (not this session's) is not its activity.
  const d = await session(300);
  const borrowed = randomUUID();
  await q(
    `insert into channels (id, context_object_type, context_object_id) values ($1, 'workspace', $2)`,
    [borrowed, WS]
  );
  await q(`update focus_sessions set channel_id = $1 where id = $2`, [
    borrowed,
    d.id,
  ]);
  await post(borrowed, 10, "human");
  elsewhere = d.id;

  // A playbook run whose session a person posted in 20 min ago.
  await q(
    `insert into playbooks (id, name, workspace_id) values ($1, 'Lane', $2)`,
    [PLAYBOOK, WS]
  );
  const e = await session(300);
  await post(e.room, 20, "human");
  runSession = e.id;
  runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, workspace_id, session_id, status, started_at)
     values ($1, $2, $3, $4, 'running', now() - interval '1 day')`,
    [runId, PLAYBOOK, WS, e.id]
  );
  await q(`update focus_sessions set playbook_id = $1 where id = $2`, [
    PLAYBOOK,
    e.id,
  ]);
});

describe("lastActivityAt counts a post in the session's own room", () => {
  it("a session that only reports in its room is active at its last post", async () => {
    const runs = await listRuns({ userId: OWNER, flowType: "session" });
    const byId = new Map(runs.map((r) => [r.id, r]));
    const at = byId.get(reporting)?.lastActivityAt ?? null;
    expect(at).toBeInstanceOf(Date);
    expect(minutesAgo(at)).toBe(10);
  });

  it("ignores the pod's notices, another session's coordination post and another room", async () => {
    const runs = await listRuns({ userId: OWNER, flowType: "session" });
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(minutesAgo(byId.get(notices)?.lastActivityAt ?? null)).toBe(300);
    expect(minutesAgo(byId.get(elsewhere)?.lastActivityAt ?? null)).toBe(300);
    // The later of the two signals: here the touch.
    expect(minutesAgo(byId.get(touched)?.lastActivityAt ?? null)).toBe(60);
  });

  it("a playbook run reads its session's room the same way", async () => {
    const runs = await listRuns({ userId: OWNER, flowType: "playbook" });
    const run = runs.find((r) => r.id === runId);
    expect(run, `run of session ${runSession}`).toBeDefined();
    expect(minutesAgo(run!.lastActivityAt)).toBe(20);
  });
});
