/**
 * THE GOAL, THE SIBLINGS and THE WORK UNITS of a session, driven through the
 * REAL `projectContinuationPacket` on PGlite (plan v5 T1, lane be-context).
 *
 * A fresh agent picking up a step must see, from the pod alone, the goal the
 * step serves (end state, criteria marks, KPI, drop conditions), the work
 * beside it (parallel, before, next) and the PRs it recorded — without the
 * conversation that started it.
 *
 * Real: the packet, `getTrack` (project-floored), `loadTrackGoalFacts`,
 * `toTrackView`, `sessionReadableWhere`, `sessionKindWhere`. Only `getTrack` is
 * wrapped, so one flag can force a FAILED read and prove it is `unavailable`,
 * never "no goal" / "nothing beside it".
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
    trackReads: 0,
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
      h.trackReads++;
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
  sessionEvaluations,
  trackParticipants,
  eq,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  projectContinuationPacket,
  workUnitsSection,
} from "../continuation-packet.js";

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
const OTHER_PROJECT = randomUUID();
const GOAL = randomUUID();
const OTHER_GOAL = randomUUID();
const S = {
  research: randomUUID(), // stage research, closed → before
  spec: randomUUID(), // stage spec — the reader under test
  specTwin: randomUUID(), // stage spec, active → parallel
  build: randomUUID(), // stage build, active → next (a later step)
  booked: randomUUID(), // no stage, scheduled → next
  elsewhere: randomUUID(), // another goal → never listed
  loose: randomUUID(), // project, no goal — project scope
  looseDone: randomUUID(), // project, no goal, closed
  receipt: randomUUID(), // project, no goal, a receipt → never a sibling
  nowhere: randomUUID(), // no project, no goal
};

async function session(
  id: string,
  opts: {
    title: string;
    status?: string;
    projectId?: string | null;
    trackId?: string | null;
    trackStage?: string | null;
    metadata?: Record<string, unknown>;
    updatedAt?: string;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, track_stage, title, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, null, $3, $4, $5, $6, $7, $8, '[]'::jsonb, $9::jsonb, 'human', now(), $10::timestamptz, now())`,
    [
      id,
      USER,
      opts.projectId ?? null,
      opts.trackId ?? null,
      opts.trackStage ?? null,
      opts.title,
      opts.title,
      opts.status ?? "active",
      JSON.stringify(opts.metadata ?? {}),
      opts.updatedAt ?? new Date().toISOString(),
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

const ids = (
  section: { status: string; items?: Array<{ id: string }> } | undefined
) => (section?.status === "ok" ? section.items!.map((i) => i.id) : section);

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
    sessionEvaluations,
    trackParticipants,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  for (const [id, name] of [
    [PROJECT, "Work, done right"],
    [OTHER_PROJECT, "Elsewhere"],
  ]) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
       values ($1, $2, null, $3, 'active', now(), now())`,
      [id, USER, name]
    );
  }
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, end_state, criteria, drop_conditions, kpi, created_at, updated_at)
     values ($1, $2, $3, 'Work map', $4::jsonb, '1', 'spec', 'active', $5, $6::jsonb, $7::jsonb, $8::jsonb, now(), now())`,
    [
      GOAL,
      PROJECT,
      USER,
      JSON.stringify({
        stages: [
          { key: "research", name: "Research" },
          { key: "spec", name: "Spec" },
          { key: "build", name: "Build" },
        ],
      }),
      "The founder sees all parallel work in one map.",
      JSON.stringify([
        {
          key: "one-map",
          statement: "Every open session shows on one map",
          check: { kind: "human" },
        },
        {
          key: "prs-joined",
          statement: "Every recorded PR joins its session",
          required: false,
          check: { kind: "evidence", evidenceKey: "prs-joined" },
        },
      ]),
      JSON.stringify(["The founder drops the map"]),
      JSON.stringify({ label: "Sessions on the map", target: 50, current: 7 }),
    ]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
     values ($1, $2, $3, 'Unrelated goal', '{}'::jsonb, '1', null, 'active', now(), now())`,
    [OTHER_GOAL, OTHER_PROJECT, USER]
  );
  const inGoal = { projectId: PROJECT, trackId: GOAL };
  await session(S.research, {
    ...inGoal,
    title: "Prior art",
    status: "closed",
    trackStage: "research",
  });
  await session(S.spec, { ...inGoal, title: "Spec it", trackStage: "spec" });
  await session(S.specTwin, {
    ...inGoal,
    title: "Spec the map legend",
    trackStage: "spec",
  });
  await session(S.build, { ...inGoal, title: "Build it", trackStage: "build" });
  await session(S.booked, {
    ...inGoal,
    title: "Dogfood on Friday",
    status: "scheduled",
  });
  await session(S.elsewhere, {
    projectId: OTHER_PROJECT,
    trackId: OTHER_GOAL,
    title: "Other goal's work",
  });
  await session(S.loose, { projectId: PROJECT, title: "Loose fix" });
  await session(S.looseDone, {
    projectId: PROJECT,
    title: "Loose fix, shipped",
    status: "closed",
  });
  await session(S.receipt, {
    projectId: PROJECT,
    title: "Agent writes",
    metadata: { kind: "agent-proposal-package" },
  });
  await session(S.nowhere, { title: "No project, no goal" });
});

describe("continuation packet — the GOAL a session serves", () => {
  it("carries the end state, every criterion with its derived mark, the KPI and the drop conditions", async () => {
    const { goal } = await packetFor(S.spec);
    expect(goal).toEqual({
      status: "ok",
      goal: {
        id: GOAL,
        name: "Work map",
        status: "active",
        statusLabel: expect.any(String),
        endState: "The founder sees all parallel work in one map.",
        direction: null,
        criteria: [
          {
            key: "one-map",
            statement: "Every open session shows on one map",
            required: true,
            mark: expect.any(String),
          },
          {
            key: "prs-joined",
            statement: "Every recorded PR joins its session",
            required: false,
            mark: expect.any(String),
          },
        ],
        criteriaMet: { met: 0, total: 2 },
        kpi: expect.objectContaining({
          label: "Sessions on the map",
          target: 50,
          current: 7,
        }),
        dropConditions: ["The founder drops the map"],
      },
    });
    // The marks are DERIVED (`loadTrackGoalFacts`), never the "not read" null.
    const marks =
      goal.status === "ok" ? goal.goal!.criteria.map((c) => c.mark) : [];
    expect(marks).not.toContain(null);
  });

  it("a session filed into no goal reads goal: null (a true state)", async () => {
    expect((await packetFor(S.loose)).goal).toEqual({
      status: "ok",
      goal: null,
    });
  });

  it("a FAILED read is unavailable, never 'no goal'", async () => {
    h.failTrackRead = true;
    try {
      expect((await packetFor(S.spec)).goal).toEqual({
        status: "unavailable",
        reason: expect.any(String),
      });
    } finally {
      h.failTrackRead = false;
    }
  });
});

describe("continuation packet — the SIBLINGS beside a session", () => {
  it("on a goal: parallel = open at its step, before = ended, next = later steps + scheduled", async () => {
    const { siblings } = await packetFor(S.spec);
    expect(siblings).toMatchObject({ scope: "goal" });
    if (!siblings || !("scope" in siblings)) throw new Error("no siblings");
    expect(ids(siblings.parallel)).toEqual([S.specTwin]);
    expect(ids(siblings.before)).toEqual([S.research]);
    expect(ids(siblings.next)).toEqual([S.build, S.booked]);
    expect(siblings.next).toMatchObject({ status: "ok", total: 2 });
    // Never itself, never another goal's work.
    const all = [
      ...(ids(siblings.parallel) as string[]),
      ...(ids(siblings.before) as string[]),
      ...(ids(siblings.next) as string[]),
    ];
    expect(all).not.toContain(S.spec);
    expect(all).not.toContain(S.elsewhere);
    expect(siblings.parallel).toMatchObject({
      items: [{ id: S.specTwin, stageKey: "spec" }],
    });
  });

  it("the last step has nothing later: its open siblings are parallel", async () => {
    const { siblings } = await packetFor(S.build);
    if (!siblings || !("scope" in siblings)) throw new Error("no siblings");
    expect(ids(siblings.next)).toEqual([S.booked]);
    expect((ids(siblings.parallel) as string[]).sort()).toEqual(
      [S.spec, S.specTwin].sort()
    );
  });

  it("with no goal, falls back to the PROJECT and leaves receipts out", async () => {
    const { siblings } = await packetFor(S.loose);
    expect(siblings).toMatchObject({ scope: "project" });
    if (!siblings || !("scope" in siblings)) throw new Error("no siblings");
    const open = ids(siblings.parallel) as string[];
    expect(open).not.toContain(S.receipt);
    expect(open).not.toContain(S.loose);
    expect(open).toContain(S.specTwin);
    expect(ids(siblings.before)).toEqual(
      expect.arrayContaining([S.looseDone, S.research])
    );
    expect(siblings.parallel).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ stageKey: null }),
      ]),
    });
  });

  it("the goal, its siblings and its prior stages share ONE track read", async () => {
    h.trackReads = 0;
    const packet = await packetFor(S.spec);
    expect(packet.goal).toMatchObject({ status: "ok" });
    expect(packet.siblings).toMatchObject({ scope: "goal" });
    expect(h.trackReads).toBe(1);
  });

  it("no goal and no project: siblings is null", async () => {
    expect((await packetFor(S.nowhere)).siblings).toBeNull();
  });

  it("a FAILED read is unavailable, never 'nothing beside it'", async () => {
    h.failTrackRead = true;
    try {
      expect((await packetFor(S.spec)).siblings).toEqual({
        status: "unavailable",
        reason: expect.any(String),
      });
    } finally {
      h.failTrackRead = false;
    }
  });
});

describe("continuation packet — the WORK UNITS a session recorded", () => {
  const slot = (s: Partial<ExpectedOutput>): ExpectedOutput =>
    ({ kind: "document", label: "x", ...s }) as ExpectedOutput;

  it("lists PR / branch outcomes and any GitHub PR ref, with the outcome's state", () => {
    const section = workUnitsSection([
      slot({
        kind: "pull_request",
        label: "backend#281",
        key: "pr-backend-281",
        ref: { url: "https://github.com/Synap-core/backend/pull/281" },
        status: "done",
      } as Partial<ExpectedOutput>),
      slot({ kind: "branch", label: "feat/x", claimedDone: true }),
      slot({
        kind: "code",
        label: "relay change",
        ref: { url: "https://github.com/Synap-core/relay-app/pull/9" },
      }),
      slot({
        kind: "pull_request",
        label: "dropped",
        retiredAt: "2026-10-27T00:00:00Z",
      } as Partial<ExpectedOutput>),
      slot({ kind: "document", label: "The plan" }),
      slot({
        kind: "document",
        label: "Docs",
        ref: { url: "https://x.dev/a" },
      }),
    ]);
    expect(section).toMatchObject({
      status: "ok",
      total: 4,
      items: [
        {
          kind: "pull_request",
          label: "backend#281",
          url: "https://github.com/Synap-core/backend/pull/281",
          state: "met",
        },
        { kind: "branch", url: null, state: "claimed" },
        { kind: "code", state: "open" },
        { kind: "pull_request", state: "retired" },
      ],
    });
  });

  it("rides on the packet (none recorded = an empty ok list)", async () => {
    expect((await packetFor(S.spec)).workUnits).toEqual({
      status: "ok",
      total: 0,
      items: [],
    });
  });
});
