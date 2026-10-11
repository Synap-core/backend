/**
 * A session whose approved proposal STARTED A TRACK names that output by the
 * track's name — not "Untitled output".
 *
 * Live defect (2026-10-11): `apply-approval.ts` recorded the approval's target
 * as a session artifact titled `expectedLabel ?? "Untitled output"`, and a
 * track create carries no slot label — only `data.name`. The outputs read
 * (`resolveTitles`) had no `track` arm, so the stored placeholder stood
 * forever, in the room and in every later step's `priorStages`.
 *
 * REACHABILITY, end to end on PGlite: the REAL `applyProposalApproval`, the
 * REAL `track/create` executor (replaying `startTrack`), the REAL
 * `recordSessionArtifact`, and the REAL `listSessionOutputs` join. Nothing is
 * hand-built between the stored proposal and the asserted output title.
 *
 * Stubbed only at the seams this suite has no infrastructure for (the same
 * seams `tracks.pglite.test.ts` stubs): `checkPermissionOrPropose` (GRANTS for
 * the human replay), link writes, side-effect emits, the event append.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  return {
    ...actual,
    db,
    getDb: async () => db,
    EventRepository: class {
      async append() {}
    },
  };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));

vi.mock("../../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLinks: async () => [],
}));

vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { applyProposalApproval } from "../../../routers/proposals/apply-approval.js";
import { listSessionOutputs } from "../session-outputs.js";

const USER = "user-1";
const AGENT = "agent-1";
const PROJECT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.hasDefault && c.name === "id" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  // The REAL track table shape (defaults matter: the service inserts without
  // them) — the same DDL `tracks.pglite.test.ts` uses.
  await h.client!.exec(`
    create table project_tracks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null,
      user_id text not null,
      playbook_id uuid,
      name text not null,
      definition_snapshot jsonb not null default '{}'::jsonb,
      method_version text not null default '1',
      current_stage text,
      status text not null default 'active',
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create schema pgboss;
    create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);
  `);
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, $2)`, [
    USER,
    `${USER}@example.test`,
  ]);
  // A pod-personal project the human owns.
  await q(
    `insert into projects (id, user_id, name, created_at, updated_at) values ($1, $2, 'Synap', now(), now())`,
    [PROJECT, USER]
  );
});

/** File + approve a track create from inside a session; returns ids. */
async function approveTrackCreateFromSession(name: string) {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, title, status, expected_outputs, created_at, updated_at)
     values ($1, $2, 'Plan the work', 'active', '[]'::jsonb, now(), now())`,
    [sessionId, USER]
  );
  const trackId = randomUUID();
  const proposalId = randomUUID();
  // The STORED envelope `checkPermissionOrPropose` writes for `start_track`:
  // request-shaped, the payload under `data` — no `expectedLabel`.
  const data = {
    targetType: "track",
    targetId: trackId,
    changeType: "create",
    data: { id: trackId, projectId: PROJECT, name },
  };
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, session_id, project_id, agent_user_id, data, comments, revision_history, created_at, updated_at)
     values ($1, 'pending', 'create', 'track', $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now())`,
    [proposalId, trackId, sessionId, PROJECT, AGENT, JSON.stringify(data)]
  );
  const { db } = await import("@synap/database");
  const { eq } = await import("drizzle-orm");
  const proposal = await (
    db as unknown as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  const result = await applyProposalApproval({
    proposal: proposal as never,
    userId: USER,
    input: { proposalId },
    ctx: { authenticated: true, userId: USER } as never,
  });
  return { sessionId, trackId, result };
}

async function outputsOf(sessionId: string) {
  const { db } = await import("@synap/database");
  const res = await listSessionOutputs({
    db: db as never,
    userId: USER,
    sessionId,
  });
  expect(res).not.toBeNull();
  return res!.outputs;
}

describe("a session that started a track names that output", () => {
  it("the approved track create reads as the track's name, not 'Untitled output'", async () => {
    const { sessionId, trackId, result } =
      await approveTrackCreateFromSession("Orchestrated work");
    expect(result.success).toBe(true);
    // The executor really created the track (the approval applied).
    const tracks = (
      await q<{ name: string }>(
        `select name from project_tracks where id = $1`,
        [trackId]
      )
    ).rows;
    expect(tracks).toEqual([{ name: "Orchestrated work" }]);

    const outputs = await outputsOf(sessionId);
    const track = outputs.find((o) => o.refId === trackId);
    expect(track).toMatchObject({
      kind: "track",
      title: "Orchestrated work",
    });
  });

  it("the stored ledger title is the proposal's name (the write side)", async () => {
    const { sessionId, trackId } =
      await approveTrackCreateFromSession("Synap connections");
    const rows = (
      await q<{ title: string }>(
        `select title from artifacts where session_id = $1 and ref_id = $2`,
        [sessionId, trackId]
      )
    ).rows;
    expect(rows).toEqual([{ title: "Synap connections" }]);
  });

  it("an old row stamped 'Untitled output' heals, and a rename shows (the read side)", async () => {
    const { sessionId, trackId } =
      await approveTrackCreateFromSession("Draft name");
    // A row written before the write-side fix.
    await q(
      `update artifacts set title = 'Untitled output' where session_id = $1`,
      [sessionId]
    );
    await q(`update project_tracks set name = 'Renamed track' where id = $1`, [
      trackId,
    ]);
    const outputs = await outputsOf(sessionId);
    expect(outputs.find((o) => o.refId === trackId)?.title).toBe(
      "Renamed track"
    );
  });
});
