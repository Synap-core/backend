/**
 * `setRunStatus`, THE run status write (reactions W1), on a real Postgres
 * (PGlite):
 *  - compare-and-set on `from`: a run that moved meanwhile is left as it is
 *    and owes nothing (a finished run's verdict is never overwritten);
 *  - the caller's columns in the same statement;
 *  - one `playbook_run` transition per row that changed, a set-based sweep
 *    included, with the run's session, project and goal, `stopReason` and
 *    the D9 categories (`waiting_on_you` paused, `failed` lost);
 *  - a pause records a hold, and an AGENT's capture into one is never refused
 *    (it gets the default hold, as the session reaper's pause does);
 *  - a row already at `to` is written and owes nothing;
 *  - an outbox that cannot be written rolls the move back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgTable } from "drizzle-orm/pg-core";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../../schema/index.js";
import { ddlFor } from "./lifecycle-pglite.js";
import { setRunStatus, RUN_PAUSE_DEFAULT_HOLD } from "../run-status.js";

let pg: PGlite;
let db: any;
const OWNER = "u-owner";
const AGENT = "u-agent";
const WORKSPACE = randomUUID();
const PLAYBOOK = randomUUID();

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.focusSessions,
    schema.playbookRuns,
    schema.lifecycleTransitionOutbox,
    schema.entities,
    schema.entityFacets,
    schema.projectTracks,
    schema.proposals,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(pg, { schema });
}, 120_000);
afterAll(async () => pg?.close());

async function run(status: string, withSession = true) {
  let sessionId: string | null = null;
  const projectId = randomUUID();
  if (withSession) {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO focus_sessions (id, user_id, goal, status, workspace_id, project_id)
       VALUES (gen_random_uuid(), $1, 'g', 'active', $2, $3) RETURNING id`,
      [OWNER, WORKSPACE, projectId]
    );
    sessionId = r.rows[0]!.id;
  }
  const r = await pg.query<{ id: string }>(
    `INSERT INTO playbook_runs (id, workspace_id, playbook_id, session_id, executor, status, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 'is-agent', $4, 'u-creator') RETURNING id`,
    [WORKSPACE, PLAYBOOK, sessionId, status]
  );
  return { runId: r.rows[0]!.id, sessionId, projectId };
}

const owedFor = (subjectId: string) =>
  pg
    .query<{ transition: Record<string, unknown> }>(
      `SELECT transition FROM lifecycle_transition_outbox WHERE transition->>'subjectId' = $1`,
      [subjectId]
    )
    .then((r) => r.rows.map((row) => row.transition));

const statusOf = async (id: string) =>
  (
    await db
      .select({ status: schema.playbookRuns.status })
      .from(schema.playbookRuns)
      .where(eq(schema.playbookRuns.id, id))
  )[0]?.status;

describe("setRunStatus", () => {
  it("moves a live run and owes ONE transition in the one shape", async () => {
    const { runId, sessionId, projectId } = await run("running");
    const { rows, transitions } = await setRunStatus(db, {
      runId,
      from: ["running", "waiting_on_you", "stale"],
      to: "failed",
      actor: { kind: "system" },
      reason: "it broke",
      set: { error: "boom", stopReason: "stages_left" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      error: "boom",
      stopReason: "stages_left",
    });
    expect(transitions).toHaveLength(1);
    const owed = await owedFor(runId);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      subjectType: "playbook_run",
      subjectId: runId,
      property: "status",
      from: "running",
      to: "failed",
      fromCategory: "active",
      category: "lost",
      actorKind: "system",
      // The run's session's person, not its creator.
      userId: OWNER,
      sessionId,
      workspaceId: WORKSPACE,
      projectId,
      playbookId: PLAYBOOK,
      stopReason: "stages_left",
      reason: "it broke",
      hold: null,
    });
  });

  it("compare-and-set: a finished run keeps its verdict and owes nothing", async () => {
    const { runId } = await run("cancelled");
    const { rows, transitions } = await setRunStatus(db, {
      runId,
      from: ["running", "waiting_on_you", "stale"],
      to: "completed",
      actor: { kind: "system" },
    });
    expect(rows).toEqual([]);
    expect(transitions).toEqual([]);
    expect(await statusOf(runId)).toBe("cancelled");
    expect(await owedFor(runId)).toEqual([]);
  });

  it("an agent's capture into a paused status records the default hold, never refused", async () => {
    const { runId } = await run("running");
    const { transitions } = await setRunStatus(db, {
      runId,
      from: ["running"],
      to: "waiting_on_you",
      actor: { kind: "agent", userId: OWNER, agentUserId: AGENT },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      category: "paused",
      actorKind: "agent",
      agentUserId: AGENT,
      hold: {
        on: RUN_PAUSE_DEFAULT_HOLD.on,
        resumeTo: "running",
      },
    });
    // Reviewed on the run cadence (7 days), never open-ended.
    expect(typeof transitions[0]!.hold!.reviewBy).toBe("string");
  });

  it("a paused run moved to another pause keeps the hold it had", async () => {
    const { runId } = await run("running");
    await setRunStatus(db, {
      runId,
      from: "running",
      to: "waiting_on_you",
      actor: { kind: "system" },
      defaultHold: { on: "person", reason: "first" },
    });
    const { transitions } = await setRunStatus(db, {
      runId,
      from: "waiting_on_you",
      to: "stale",
      actor: { kind: "system" },
      defaultHold: { on: "agent", reason: "second" },
    });
    expect(transitions[0]!.hold).toMatchObject({
      reason: "first",
      resumeTo: "running",
    });
  });

  it("a sweep owes one transition per row, a session-less run its creator's", async () => {
    const a = await run("running");
    const b = await run("running", false);
    const c = await run("completed");
    const { transitions } = await setRunStatus(db, {
      where: inArray(schema.playbookRuns.id, [a.runId, b.runId, c.runId]),
      from: "running",
      to: "stale",
      actor: { kind: "system" },
    });
    expect(transitions.map((t) => t.subjectId).sort()).toEqual(
      [a.runId, b.runId].sort()
    );
    expect(transitions.find((t) => t.subjectId === b.runId)).toMatchObject({
      userId: "u-creator",
      sessionId: null,
      projectId: null,
    });
    expect(await statusOf(c.runId)).toBe("completed");
  });

  it("a row already at `to` is written and owes nothing", async () => {
    const { runId } = await run("running");
    const { rows, transitions } = await setRunStatus(db, {
      runId,
      from: ["running"],
      to: "running",
      actor: { kind: "system" },
      set: { summary: "still going" },
    });
    expect(rows[0]).toMatchObject({ summary: "still going" });
    expect(transitions).toEqual([]);
    expect(await owedFor(runId)).toEqual([]);
  });

  it("an outbox that cannot be written rolls the move back", async () => {
    const { runId } = await run("running");
    await pg.exec(
      `ALTER TABLE lifecycle_transition_outbox RENAME TO lifecycle_transition_outbox_x`
    );
    try {
      await expect(
        setRunStatus(db, {
          runId,
          from: "running",
          to: "failed",
          actor: { kind: "system" },
        })
      ).rejects.toThrow();
    } finally {
      await pg.exec(
        `ALTER TABLE lifecycle_transition_outbox_x RENAME TO lifecycle_transition_outbox`
      );
    }
    expect(await statusOf(runId)).toBe("running");
  });

  it("needs a runId or a where", async () => {
    await expect(
      setRunStatus(db, {
        from: "running",
        to: "failed",
        actor: { kind: "system" },
      })
    ).rejects.toThrow(/runId or a where/);
  });
});
