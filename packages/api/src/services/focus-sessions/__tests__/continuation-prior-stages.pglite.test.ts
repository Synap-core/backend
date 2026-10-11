/**
 * THE STAGE BRIEF, driven through the REAL `projectContinuationPacket` on PGlite.
 *
 * A stage session must start from what the EARLIER stages of its track
 * produced — pod references, not the previous chat — and the producer of an
 * earlier stage is usually CLOSED, so no live edge links the two. The packet
 * derives it: the track's pinned stage order (`deriveTrackStages`), the
 * sessions filed at the earlier stages, and their outputs through the batched
 * outputs join.
 *
 * Real: the packet, `getTrack` (project-floored through the access layer),
 * `listOutputsForSessions`, `sessionReadableWhere`. Only `getTrack` is wrapped,
 * so one row can force a FAILED read and prove it is `unavailable`, never "no
 * earlier stages".
 *
 * NOT covered: the tRPC/Hub/MCP doors' plumbing — all three attach this one
 * function's result verbatim (`focus-sessions.get-continuation.pglite.test.ts`).
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
    failTrackRead: false,
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
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("../../tracks/tracks-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.getTrack as (...a: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    getTrack: async (...a: unknown[]) => {
      if (h.failTrackRead) throw new Error("track read exploded");
      return real(...a);
    },
  };
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
  projectTracks,
  projectMembers,
  messages,
  workspaces,
  workspaceMembers,
  podMembers,
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

const PROJECT = randomUUID();
const TRACK = randomUUID();
const DOC = randomUUID();
const S = {
  research: randomUUID(), // stage 1, closed, produced DOC
  spec: randomUUID(), // stage 2 — the reader under test
  build: randomUUID(), // stage 3
  loose: randomUUID(), // no track
};

async function session(
  id: string,
  opts: { title: string; status?: string; trackStage?: string | null }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, track_stage, title, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, null, $3, $4, $5, $6, $7, $8, '[]'::jsonb, '{}'::jsonb, 'human', now(), now(), now())`,
    [
      id,
      USER,
      opts.trackStage === undefined ? null : PROJECT,
      opts.trackStage === undefined ? null : TRACK,
      opts.trackStage ?? null,
      opts.title,
      opts.title,
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
    projectTracks,
    projectMembers,
    messages,
    workspaces,
    workspaceMembers,
    podMembers,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Research to spec', 'active', now(), now())`,
    [PROJECT, USER]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
     values ($1, $2, $3, 'Discovery', $4::jsonb, '1', 'spec', 'active', now(), now())`,
    [
      TRACK,
      PROJECT,
      USER,
      JSON.stringify({
        stages: [
          { key: "research", name: "Research" },
          { key: "spec", name: "Spec" },
          { key: "build", name: "Build" },
        ],
      }),
    ]
  );
  await session(S.research, {
    title: "Prior-art study",
    status: "closed",
    trackStage: "research",
  });
  await session(S.spec, { title: "Write the spec", trackStage: "spec" });
  await session(S.build, { title: "Build it", trackStage: "build" });
  await session(S.loose, { title: "Not in a track" });
  await q(
    `insert into artifacts (id, session_id, user_id, kind, ref_id, title, origin_kind, state, props, created_at)
     values ($1, $2, $3, 'document', $4, 'Prior art — 8 products', 'agent', 'kept', '{}'::jsonb, now())`,
    [randomUUID(), S.research, USER, DOC]
  );
});

describe("continuation packet — what the earlier stages produced", () => {
  it("a stage-2 session lists the CLOSED stage-1 session and its document", async () => {
    const packet = await packetFor(S.spec);
    expect(packet.priorStages).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          id: S.research,
          title: "Prior-art study",
          status: "closed",
          statusLabel: expect.any(String),
          stageKey: "research",
          stageName: "Research",
          outputs: {
            status: "ok",
            total: 1,
            items: [expect.objectContaining({ kind: "document", refId: DOC })],
          },
        },
      ],
    });
  });

  it("never lists its own stage or a later one; nearest earlier stage first", async () => {
    const research = await packetFor(S.research);
    expect(research.priorStages).toEqual({ status: "ok", total: 0, items: [] });
    const build = await packetFor(S.build);
    expect(
      build.priorStages?.status === "ok" &&
        build.priorStages.items.map((i) => i.stageKey)
    ).toEqual(["spec", "research"]);
  });

  it("a session in no track gets no section", async () => {
    expect((await packetFor(S.loose)).priorStages).toBeNull();
  });

  it("a FAILED read is unavailable, never 'no earlier stages'", async () => {
    h.failTrackRead = true;
    try {
      expect((await packetFor(S.spec)).priorStages).toEqual({
        status: "unavailable",
        reason: expect.any(String),
      });
    } finally {
      h.failTrackRead = false;
    }
  });
});

describe("continuation packet — a STAGE-LESS track degrades to its recent closed sessions (W1)", () => {
  const LASTING = randomUUID();
  const L = { done: randomUUID(), open: randomUUID(), now: randomUUID() };
  const NOTE = randomUUID();

  async function lastingSession(id: string, title: string, status: string) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, track_stage, title, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
       values ($1, $2, null, $3, $4, null, $5, $6, $7, '[]'::jsonb, '{}'::jsonb, 'human', now(), now(), now())`,
      [id, USER, PROJECT, LASTING, title, title, status]
    );
  }

  beforeAll(async () => {
    await q(
      `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
       values ($1, $2, $3, 'Grow the newsletter', '{}'::jsonb, '1', null, 'active', now(), now())`,
      [LASTING, PROJECT, USER]
    );
    await lastingSession(L.done, "Issue #12", "closed");
    await lastingSession(L.open, "Issue #13 draft", "active");
    await lastingSession(L.now, "Issue #14", "active");
    await q(
      `insert into artifacts (id, session_id, user_id, kind, ref_id, title, origin_kind, state, props, created_at)
       values ($1, $2, $3, 'document', $4, 'Issue #12 — sent', 'agent', 'kept', '{}'::jsonb, now())`,
      [randomUUID(), L.done, USER, NOTE]
    );
  });

  it("lists the track's CLOSED sessions (not open ones, not itself) with what they produced", async () => {
    expect((await packetFor(L.now)).priorStages).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          id: L.done,
          title: "Issue #12",
          status: "closed",
          statusLabel: expect.any(String),
          stageKey: null,
          stageName: null,
          outputs: {
            status: "ok",
            total: 1,
            items: [expect.objectContaining({ kind: "document", refId: NOTE })],
          },
        },
      ],
    });
  });

  it("the closed session itself does not list itself", async () => {
    expect((await packetFor(L.done)).priorStages).toEqual({
      status: "ok",
      total: 0,
      items: [],
    });
  });
});
