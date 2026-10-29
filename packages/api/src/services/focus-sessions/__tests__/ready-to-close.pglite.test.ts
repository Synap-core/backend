/**
 * F4 (plan v5, lane be-context) — "every outcome is produced, nothing is owed:
 * close it", said to the agent at once instead of after a week idle.
 *
 * Two doors, ONE rule: the `update_session` nudge (`loadSessionNudges`,
 * `readyToClose`) and orient's `looseEnds.readyToClose`
 * (`readSessionsReadyToClose`) both read the session's next move through
 * `attachNextMove` → `deriveNextMove`, the rule the continuation packet and the
 * person's needs-you `review` fold already use. Never a second "done" rule.
 *
 * Real, on PGlite: both readers, the next-move batch read, the evaluation
 * summary. Only the database handle is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, { schema });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  proposals,
  users,
  workspaces,
  workspaceMembers,
  artifacts,
  links,
  entities,
  documents,
  views,
  automations,
  playbooks,
  projects,
  projectTracks,
  podMembers,
  projectMembers,
  channels,
  channelMembers,
  events,
  messages,
  sessionEvaluations,
  eq,
} from "@synap/database";
import { readSessionsReadyToClose } from "../../discover/loose-ends.js";
import {
  computeSessionNudges,
  loadSessionNudges,
  mayBeReadyToClose,
  type NudgeSessionLike,
} from "../session-nudges.js";

const PERSON = "person-1";
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = t.endsWith("[]") && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const delivered = {
  key: "pr-backend-281",
  kind: "pull_request",
  label: "backend#281",
  ref: { url: "https://github.com/Synap-core/backend/pull/281" },
  status: "done",
  completedAt: "2026-10-27T10:00:00Z",
};
const stillOpen = { key: "spec", kind: "document", label: "The spec" };
const owedByPerson = {
  key: "pick",
  kind: "decision",
  label: "Pick a name",
  owner: "human",
  blockedReason: "decision",
  why: "only you can",
};

async function session(p: {
  agent?: string;
  outputs?: unknown[];
  criteria?: unknown[];
  status?: string;
  goal?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, agent_ids, expected_outputs, criteria, metadata, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, 'agent', $5::text[], $6::jsonb, $8::jsonb, $7::jsonb, now(), now(), now())`,
    [
      id,
      PERSON,
      p.goal ?? "ship the fix",
      p.status ?? "active",
      `{${p.agent ?? AGENT}}`,
      JSON.stringify(p.outputs ?? []),
      // Already offered: keeps the playbook matcher out of the nudge read.
      JSON.stringify({ playbookOfferedAt: "2026-10-27T00:00:00Z" }),
      JSON.stringify(p.criteria ?? []),
    ]
  );
  return id;
}

/** One `session_evaluations` row, as the grade door writes it. */
async function grade(
  sessionId: string,
  criterionKey: string,
  verdict: "pass" | "fail"
): Promise<void> {
  await q(
    `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evaluator_id, evidence, created_at)
     values ($1, $2, $3, $4, 1, $5, 'evidence', 'ci', '{}'::jsonb, now())`,
    [randomUUID(), sessionId, PERSON, criterionKey, verdict]
  );
}

const ciGreen = {
  key: "ci-green",
  statement: "CI is green on the PR",
  check: { kind: "evidence", evidenceKey: "ci" },
};
const optionalNote = {
  key: "note",
  statement: "A note is posted",
  required: false,
  check: { kind: "judge" },
};

async function row(id: string) {
  const [r] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, id));
  return r!;
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    artifacts,
    links,
    entities,
    documents,
    views,
    automations,
    playbooks,
    projects,
    projectTracks,
    podMembers,
    projectMembers,
    channels,
    channelMembers,
    events,
    messages,
    sessionEvaluations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

beforeEach(async () => {
  await q(`delete from focus_sessions`);
  await q(`delete from session_evaluations`);
});

describe("update_session nudge: readyToClose (F4)", () => {
  it("every declared outcome produced, nothing owed: the reply says close it", async () => {
    const id = await session({ outputs: [delivered] });
    const nudges = await loadSessionNudges({
      session: await row(id),
      phase: "update",
      userId: PERSON,
      agentUserId: AGENT,
    });
    expect(nudges).toMatchObject({
      readyToClose: { reason: expect.any(String) },
      hints: expect.arrayContaining([
        expect.stringContaining("complete_session"),
      ]),
    });
  });

  it("a REQUIRED criterion without a passing grade holds it back (rung 6b); its pass releases it", async () => {
    const id = await session({ outputs: [delivered], criteria: [ciGreen] });
    const nudge = async () =>
      loadSessionNudges({
        session: await row(id),
        phase: "update",
        userId: PERSON,
        agentUserId: AGENT,
      });
    const unmet = await nudge();
    expect(unmet && "readyToClose" in unmet).toBeFalsy();
    await grade(id, "ci-green", "fail");
    const failed = await nudge();
    expect(failed && "readyToClose" in failed).toBeFalsy();

    await grade(id, "ci-green", "pass");
    expect(await nudge()).toMatchObject({
      readyToClose: {
        reason: expect.stringContaining("every required criterion passes"),
      },
      hints: expect.arrayContaining([
        expect.stringContaining(
          "every required criterion passes and nothing is owed: close with complete_session"
        ),
      ]),
    });
  });

  it("an OPTIONAL criterion ungraded never holds it back; the hint says to grade it, then close", async () => {
    const id = await session({
      outputs: [delivered],
      criteria: [ciGreen, optionalNote],
    });
    await grade(id, "ci-green", "pass");
    const nudges = await loadSessionNudges({
      session: await row(id),
      phase: "update",
      userId: PERSON,
      agentUserId: AGENT,
    });
    expect(nudges).toMatchObject({
      ungradedCriteria: ["note"],
      readyToClose: expect.any(Object),
      hints: expect.arrayContaining([
        expect.stringContaining(
          "grade the optional criteria above with evaluate_session, then close with complete_session"
        ),
      ]),
    });
  });

  it("only OPTIONAL criteria, none graded: ready, through the real verdict", async () => {
    const id = await session({
      outputs: [delivered],
      criteria: [optionalNote],
    });
    expect(
      await loadSessionNudges({
        session: await row(id),
        phase: "update",
        userId: PERSON,
        agentUserId: AGENT,
      })
    ).toMatchObject({
      ungradedCriteria: ["note"],
      readyToClose: {
        reason: expect.stringContaining("every required criterion passes"),
      },
    });
  });

  it("said ONCE per set of outputs; re-armed when the outputs change", async () => {
    const id = await session({ outputs: [delivered] });
    const nudge = async () =>
      loadSessionNudges({
        session: await row(id),
        phase: "update",
        userId: PERSON,
        agentUserId: AGENT,
      });
    expect(await nudge()).toMatchObject({ readyToClose: expect.any(Object) });
    // The same outputs again: not repeated on every update_session.
    const again = await nudge();
    expect(again && "readyToClose" in again).toBeFalsy();
    // A new delivered output: the session is ready again, for new outputs.
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [
        id,
        JSON.stringify([
          delivered,
          {
            ...delivered,
            key: "pr-backend-282",
            label: "backend#282",
            ref: { url: "https://github.com/Synap-core/backend/pull/282" },
          },
        ]),
      ]
    );
    expect(await nudge()).toMatchObject({ readyToClose: expect.any(Object) });
  });

  it("an outcome still open on the agent: no readyToClose", async () => {
    const id = await session({ outputs: [delivered, stillOpen] });
    const nudges = await loadSessionNudges({
      session: await row(id),
      phase: "update",
      userId: PERSON,
      agentUserId: AGENT,
    });
    expect(nudges && "readyToClose" in nudges).toBeFalsy();
  });

  it("the person still owes something: no readyToClose", async () => {
    const id = await session({ outputs: [delivered, owedByPerson] });
    const nudges = await loadSessionNudges({
      session: await row(id),
      phase: "update",
      userId: PERSON,
      agentUserId: AGENT,
    });
    expect(nudges && "readyToClose" in nudges).toBeFalsy();
  });

  it("never at complete (the session is closing already)", () => {
    const out = computeSessionNudges({
      session: {
        playbookId: null,
        origin: "agent",
        currentStage: null,
        stages: [],
        expectedOutputs: [delivered],
        metadata: {},
      },
      evaluation: { criteria: [], evaluations: [] },
      phase: "complete",
      nextMove: { kind: "ready_to_close", reason: "all produced" },
    });
    expect(out?.readyToClose).toBeUndefined();
  });

  it("the pre-check only lets a session with live, delivered slots through", () => {
    const base: Omit<NudgeSessionLike, "expectedOutputs"> = {
      playbookId: null,
      origin: "agent",
      currentStage: null,
      stages: [],
      metadata: {},
    };
    expect(mayBeReadyToClose({ ...base, expectedOutputs: [delivered] })).toBe(
      true
    );
    expect(mayBeReadyToClose({ ...base, expectedOutputs: [] })).toBe(false);
    expect(
      mayBeReadyToClose({ ...base, expectedOutputs: [delivered, stillOpen] })
    ).toBe(false);
    expect(
      mayBeReadyToClose({
        ...base,
        expectedOutputs: [delivered, owedByPerson],
      })
    ).toBe(false);
  });
});

describe("orient looseEnds.readyToClose (F4): at once, never idle-gated", () => {
  it("lists the agent's own ready session (updated just now), with the close call", async () => {
    const ready = await session({ outputs: [delivered], goal: "ready" });
    await session({ outputs: [delivered, stillOpen], goal: "still working" });
    await session({ outputs: [], goal: "declared nothing" });
    await session({ agent: OTHER_AGENT, outputs: [delivered] });
    await session({ outputs: [delivered], status: "closed" });

    const r = await readSessionsReadyToClose({
      userId: PERSON,
      agentUserId: AGENT,
    });
    expect(r).toMatchObject({ count: 1, countIsLowerBound: false });
    const items = (r as { items: Array<{ id: string; close: string }> }).items;
    expect(items.map((i) => i.id)).toEqual([ready]);
    expect(items[0]!.close).toContain(
      `synap_complete_session {"sessionId":"${ready}"}`
    );
  });

  it("never lists a session whose required criterion does not pass yet", async () => {
    const unmet = await session({
      outputs: [delivered],
      criteria: [ciGreen],
      goal: "criterion unmet",
    });
    const met = await session({
      outputs: [delivered],
      criteria: [ciGreen],
      goal: "criterion met",
    });
    await grade(met, "ci-green", "pass");
    const r = await readSessionsReadyToClose({
      userId: PERSON,
      agentUserId: AGENT,
    });
    const items = (r as { items: Array<{ id: string }> }).items;
    expect(items.map((i) => i.id)).toEqual([met]);
    expect(items.map((i) => i.id)).not.toContain(unmet);
  });

  it("a FAILED read is unavailable, never 'nothing to close'", async () => {
    await h.client!.exec(`alter table focus_sessions rename to fs_gone`);
    try {
      expect(
        await readSessionsReadyToClose({ userId: PERSON, agentUserId: AGENT })
      ).toEqual({ status: "unavailable" });
    } finally {
      await h.client!.exec(`alter table fs_gone rename to focus_sessions`);
    }
  });
});
