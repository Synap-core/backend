/**
 * The LEAN session read (C8, `session-lean.ts`): a wake's read is a fraction of
 * the full one and holds none of the owner's OTHER sessions' deploys, which
 * move to a by-commit gate read.
 *
 * Fixture: one session of OWNER with a room, a deliverable and its own deploy,
 * beside 20 deploys a person approved on 20 OTHER sessions of the same owner
 * (the live shape: `ownerDeploys` carried ~20 foreign deploys, 12.7 KB of 39).
 * Everything runs through the real packet projection on PGlite: nothing
 * downstream of it is hand-built.
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
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db, focusSessions, eq } from "@synap/database";
import { projectContinuationPacket } from "../continuation-packet.js";
import {
  parseSessionReadDetail,
  readLeanSession,
  readSessionDeploys,
} from "../session-lean.js";

const OWNER = "user-owner";
const OTHER = "user-other";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const MINE = randomUUID();
const CH = randomUUID();
const OWN_SHA = "a0a0a0a0a0a0";
const FOREIGN = Array.from({ length: 20 }, (_, i) => ({
  session: randomUUID(),
  sha: `f${String(i).padStart(2, "0")}f${String(i).padStart(2, "0")}f${String(i).padStart(2, "0")}f0`,
}));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function insertSession(id: string, channelId: string | null) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, title, goal, status, expected_outputs, metadata, origin, channel_id, created_at, updated_at, started_at)
     values ($1, $2, null, null, $3, 'Ship it', 'active', $4::jsonb, '{}'::jsonb, 'human', $5, now(), now(), now())`,
    [
      id,
      OWNER,
      `Session ${id.slice(0, 4)}`,
      JSON.stringify(
        id === MINE
          ? [{ label: "Write the handler", kind: "task", key: "handler" }]
          : []
      ),
      channelId,
    ]
  );
}

async function deployApproval(sessionId: string, sha: string, ago: number) {
  const at = minutesAgo(ago).toISOString();
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, data, status, session_id, created_by, reviewed_by, reviewed_at, created_at, updated_at)
     values ($1, 'focus_session', $2, 'dev.deploy_approval', $3::jsonb, 'approved', $6, $4, $4, $5, $5, $5)`,
    [
      randomUUID(),
      sessionId,
      JSON.stringify({
        sessionId,
        repo: "synap-backend",
        branch: "feat/some-long-branch-name",
        commitSha: sha,
        gateReport: { passed: true },
        targetHost: "pod-prod",
        deployCommand: "git push origin " + sha + ":main",
        step: "push",
      }),
      OWNER,
      at,
      sessionId,
    ]
  );
}

async function rowOf(id: string) {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, id));
  return row!;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, user_type) values ($1, 'human'), ($2, 'human')`,
    [OWNER, OTHER]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, created_at, updated_at)
     values ($1, $2, null, 'ai_thread', now(), now())`,
    [CH, OWNER]
  );
  await insertSession(MINE, CH);
  // 6 room messages, oldest first: "message 0" .. "message 5".
  for (let i = 0; i < 6; i++) {
    await q(
      `insert into messages (id, channel_id, role, author_type, user_id, content, timestamp, ephemeral, hash, previous_hash)
       values ($1, $2, 'user', 'human', $3, $4, $5, false, 'h', '')`,
      [
        randomUUID(),
        CH,
        OWNER,
        `message ${i}`,
        minutesAgo(60 - i).toISOString(),
      ]
    );
  }
  // The session's own deploy is the OLDEST, so a capped "all" read is full of
  // the others.
  await deployApproval(MINE, OWN_SHA, 500);
  for (const [i, f] of FOREIGN.entries()) {
    await insertSession(f.session, null);
    await deployApproval(f.session, f.sha, 10 + i);
  }
});

describe("lean session read (C8)", () => {
  it("full (the default) still lists the owner's deploys on other sessions", async () => {
    const full = await projectContinuationPacket(await rowOf(MINE), {
      database: db,
      userId: OWNER,
    });
    if (full.gates.status !== "ok") throw new Error("gates unavailable");
    // 21 approved, capped at 20 newest: all foreign, today's behaviour.
    expect(full.gates.ownerDeploys).toHaveLength(20);
    expect(
      full.gates.ownerDeploys.filter((d) => d.sessionId !== MINE).length
    ).toBeGreaterThanOrEqual(19);
  });

  it("lean holds none of another session's deploys, and still holds its own", async () => {
    const lean = await readLeanSession(await rowOf(MINE), { userId: OWNER });
    const gates = lean.continuation.gates;
    if (gates.status !== "ok") throw new Error("gates unavailable");
    expect(gates.ownerDeploys.map((d) => d.sessionId)).toEqual([MINE]);
    expect(gates.ownerDeploys[0]!.commitSha).toBe(OWN_SHA);
    // Not only the typed field: no foreign sha or session id anywhere in the payload.
    const wire = JSON.stringify(lean);
    for (const f of FOREIGN) {
      expect(wire).not.toContain(f.sha);
      expect(wire).not.toContain(f.session);
    }
  });

  it("is a fraction of the full read (bytes, same fixture)", async () => {
    const row = await rowOf(MINE);
    const { readSessionOutcomesSection } =
      await import("../session-outputs.js");
    const full = JSON.stringify({
      continuation: await projectContinuationPacket(row, {
        database: db,
        userId: OWNER,
      }),
      outcomes: await readSessionOutcomesSection({
        db,
        userId: OWNER,
        sessionId: MINE,
      }),
    });
    const lean = JSON.stringify(await readLeanSession(row, { userId: OWNER }));
    // eslint-disable-next-line no-console
    console.log(
      `session read size: full ${full.length} B, lean ${lean.length} B (${Math.round((100 * lean.length) / full.length)}%)`
    );
    expect(lean.length).toBeLessThan(full.length / 2);
  });

  it("carries the outcomes, the next move, and the room's last 3 newest first", async () => {
    const lean = await readLeanSession(await rowOf(MINE), { userId: OWNER });
    if (lean.outcomes.status !== "ok") throw new Error("outcomes unavailable");
    expect(lean.outcomes.outcomes).toEqual([
      expect.objectContaining({ label: "Write the handler", met: false }),
    ]);
    expect(lean.continuation.nextMove.kind).toBeTruthy();
    const room = lean.continuation.room;
    if (room.status !== "ok") throw new Error("room unavailable");
    expect(room.last).toHaveLength(3);
    expect(room.last.map((m) => m.fenced.includes("message 5"))).toEqual([
      true,
      false,
      false,
    ]);
    expect(room.hasMore).toBe(true);
    expect(room.unread).toBe(0);
  });
});

describe("deploys gate read (C8)", () => {
  it("lists the owner's deploys across sessions, or only the commit asked for", async () => {
    const row = await rowOf(MINE);
    const all = await readSessionDeploys(row, { userId: OWNER });
    if (all.status !== "ok") throw new Error("unavailable");
    expect(all.deploys).toHaveLength(20);
    const one = await readSessionDeploys(row, {
      userId: OWNER,
      commitSha: FOREIGN[3]!.sha.slice(0, 8),
    });
    if (one.status !== "ok") throw new Error("unavailable");
    expect(one.deploys.map((d) => [d.commitSha, d.sessionId])).toEqual([
      [FOREIGN[3]!.sha, FOREIGN[3]!.session],
    ]);
    // The session's own, though past the cap of the unfiltered list.
    const own = await readSessionDeploys(row, {
      userId: OWNER,
      commitSha: OWN_SHA.slice(0, 6),
    });
    if (own.status !== "ok") throw new Error("unavailable");
    expect(own.deploys.map((d) => d.sessionId)).toEqual([MINE]);
  });

  it("is the owner's alone: a person seated in the room reads none", async () => {
    const r = await readSessionDeploys(await rowOf(MINE), { userId: OTHER });
    if (r.status !== "ok") throw new Error("unavailable");
    expect(r.deploys).toEqual([]);
  });
});

describe("detail argument", () => {
  it("defaults to full, accepts the three values, refuses the rest", () => {
    expect(parseSessionReadDetail(undefined)).toBe("full");
    expect(parseSessionReadDetail("lean")).toBe("lean");
    expect(parseSessionReadDetail("deploys")).toBe("deploys");
    expect(parseSessionReadDetail("brief")).toBeNull();
  });
});
