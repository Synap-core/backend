/**
 * THE POP, driven through the REAL `projectContinuationPacket` on PGlite.
 *
 * The shape under test: an intent opens a session, building what it needs is a
 * CHILD session, and coming back must restate BOTH *which session* and *what
 * you were about to do there* — without a second call and without a uuid.
 *
 * Real: `projectContinuationPacket` (and therefore `readParentRow`,
 * `readResume`, `readSuspendedChild`), `recordSessionSpawn` — the actual
 * producer of both the `spawned_from` edge and the parent's
 * `metadata.suspended` note — `resolveSessionTitle`, `resolveStatusLabel`.
 * Tables are generated from the Drizzle definitions. Nothing about the packet
 * is hand-built: the note reaches the assertion only because the producer wrote
 * it and the projection read it.
 *
 * The DISCRIMINATING row is `secondDetour`: the parent's note is ONE slot and
 * the last push wins, so after a second detour the note speaks for the SECOND
 * child. A projection that simply forwarded `parent.metadata.suspended.intent`
 * passes every other row here and fails only that one.
 *
 * NOT covered: the `unavailable` branch (a driver-level failure of the parent
 * read), and the tRPC/Hub/MCP doors' plumbing of `continuation` (typecheck, and
 * `focus-sessions.get-continuation.pglite.test.ts`).
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

// `recordSessionSpawn` lives in `@synap/database` and writes through that
// package's OWN connection, not the barrel's `db` — pinning both to the same
// PGlite is what makes the producer REAL here instead of stubbed.
vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  proposals,
  users,
  links,
  artifacts,
  entities,
  documents,
  views,
  automations,
  playbooks,
  projects,
  messages,
  workspaces,
  workspaceMembers,
  recordSessionSpawn,
  eq,
} from "@synap/database";
import { projectContinuationPacket } from "../continuation-packet.js";

const USER = "user-1";
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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const S = {
  parent: randomUUID(), // the intent — put down for `child`
  child: randomUUID(), // the detour that cleared the way
  lonely: randomUUID(), // never pushed, never pushed from
  quietParent: randomUUID(), // pushed a child WITHOUT recording an intent
  quietChild: randomUUID(),
  twicePushed: randomUUID(), // pushed `firstDetour`, then `secondDetour`
  firstDetour: randomUUID(),
  secondDetour: randomUUID(),
  closedChildParent: randomUUID(), // its detour has finished
  closedChild: randomUUID(),
};

async function session(
  id: string,
  opts: {
    goal: string;
    title?: string | null;
    status?: string;
    user?: string;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, title, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, null, null, $3, $4, $5, '[]'::jsonb, '{}'::jsonb, 'human', now(), now(), now())`,
    [
      id,
      opts.user ?? USER,
      opts.title ?? null,
      opts.goal,
      opts.status ?? "active",
    ]
  );
}

async function packetFor(id: string) {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, id));
  return projectContinuationPacket(row!, { database: db, userId: USER });
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    links,
    artifacts,
    entities,
    documents,
    views,
    automations,
    playbooks,
    projects,
    messages,
    workspaces,
    workspaceMembers,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // `ddlFor` projects columns only — no defaults — but `recordSessionSpawn`
  // inserts `id`/`created_at` as DEFAULT, and names the unique edge index as
  // its ON CONFLICT arbiter by column list. Both are restored here so the
  // producer runs unmodified.
  await h.client!.exec(
    `alter table links alter column id set default gen_random_uuid();
     alter table links alter column created_at set default now();
     create unique index idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );

  await session(S.parent, { title: "Launch billing", goal: "Bill customers" });
  await session(S.child, { title: "Stripe keys", goal: "Get the keys" });
  await session(S.lonely, { title: "Read the docs", goal: "Understand it" });
  await session(S.quietParent, { title: "Quiet", goal: "Something" });
  await session(S.quietChild, {
    title: "Quiet detour",
    goal: "Something else",
  });
  await session(S.twicePushed, { title: "Twice", goal: "Two detours" });
  await session(S.firstDetour, { title: "First detour", goal: "One" });
  await session(S.secondDetour, { title: "Second detour", goal: "Two" });
  await session(S.closedChildParent, { title: "Waiting", goal: "Resume me" });
  await session(S.closedChild, {
    title: "Finished detour",
    goal: "Done",
    status: "closed",
  });

  // THE REAL PRODUCER writes both the edge and the parent's suspend note.
  await recordSessionSpawn({
    childSessionId: S.child,
    parentSessionId: S.parent,
    userId: USER,
    suspendedIntent: "Draft the pricing page",
  });
  await recordSessionSpawn({
    childSessionId: S.quietChild,
    parentSessionId: S.quietParent,
    userId: USER,
  });
  await recordSessionSpawn({
    childSessionId: S.firstDetour,
    parentSessionId: S.twicePushed,
    userId: USER,
    suspendedIntent: "Write the migration",
  });
  await recordSessionSpawn({
    childSessionId: S.secondDetour,
    parentSessionId: S.twicePushed,
    userId: USER,
    suspendedIntent: "Wire the executor",
  });
  await recordSessionSpawn({
    childSessionId: S.closedChild,
    parentSessionId: S.closedChildParent,
    userId: USER,
    suspendedIntent: "Send the invoice",
  });
});

describe("continuation packet — the pop", () => {
  it("a detour names the session it returns to AND what was about to happen there", async () => {
    const packet = await packetFor(S.child);
    expect(packet.resume).toEqual({
      status: "ok",
      returnTo: {
        sessionId: S.parent,
        title: "Launch billing",
        status: "active",
        statusLabel: expect.any(String),
        intent: "Draft the pricing page",
        suspendedAt: expect.any(String),
      },
      suspended: null,
    });
    // The title is the NAME, never the id — the whole point of the projection.
    expect(packet.resume).toMatchObject({
      returnTo: { title: "Launch billing" },
    });
    expect(JSON.stringify(packet.resume)).not.toContain('"title":"' + S.parent);
  });

  it("the parent sees what IT was about to do, and the live status of its detour", async () => {
    const packet = await packetFor(S.parent);
    expect(packet.resume).toEqual({
      status: "ok",
      returnTo: null,
      suspended: {
        intent: "Draft the pricing page",
        at: expect.any(String),
        child: {
          sessionId: S.child,
          title: "Stripe keys",
          status: "active",
          statusLabel: expect.any(String),
        },
      },
    });
  });

  it("a parent whose detour CLOSED reads the finished status — the pop is legible", async () => {
    const packet = await packetFor(S.closedChildParent);
    expect(packet.resume).toMatchObject({
      status: "ok",
      suspended: {
        intent: "Send the invoice",
        child: {
          sessionId: S.closedChild,
          title: "Finished detour",
          status: "closed",
        },
      },
    });
  });

  it("DISCRIMINATING: a note names the LAST push, so an earlier detour gets NO intent", async () => {
    const first = await packetFor(S.firstDetour);
    const second = await packetFor(S.secondDetour);

    // The parent is named for BOTH — you still know where you are going back to.
    expect(first.resume).toMatchObject({
      status: "ok",
      returnTo: { sessionId: S.twicePushed, title: "Twice" },
    });
    // …but only the child the note NAMES gets the line.
    expect(
      (first.resume as { returnTo?: { intent?: string } }).returnTo?.intent
    ).toBeUndefined();
    expect(second.resume).toMatchObject({
      returnTo: { intent: "Wire the executor" },
    });
  });

  it("no detour and no parent carries NOTHING — absence is not an error", async () => {
    const packet = await packetFor(S.lonely);
    expect(packet.resume).toEqual({
      status: "ok",
      returnTo: null,
      suspended: null,
    });
    expect(packet.parent).toEqual({ status: "ok", session: null });
  });

  it("a push that recorded no intent still names the parent, with no line", async () => {
    const child = await packetFor(S.quietChild);
    expect(child.resume).toEqual({
      status: "ok",
      returnTo: {
        sessionId: S.quietParent,
        title: "Quiet",
        status: "active",
        statusLabel: expect.any(String),
      },
      suspended: null,
    });
    // And the parent itself: pushed, but with nothing to restate.
    const parent = await packetFor(S.quietParent);
    expect(parent.resume).toMatchObject({ suspended: null });
  });

  it("`parent` and `resume.returnTo` name the SAME session — one read, two projections", async () => {
    const packet = await packetFor(S.child);
    expect(packet.parent).toEqual({
      status: "ok",
      session: {
        id: S.parent,
        title: "Launch billing",
        status: "active",
        statusLabel: expect.any(String),
      },
    });
    const returnTo = (
      packet.resume as { returnTo: { sessionId: string; title: string } }
    ).returnTo;
    const parent = (packet.parent as { session: { id: string; title: string } })
      .session;
    expect(returnTo.sessionId).toBe(parent.id);
    expect(returnTo.title).toBe(parent.title);
  });
});
