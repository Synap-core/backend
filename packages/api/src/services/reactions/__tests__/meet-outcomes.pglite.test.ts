/**
 * POD DEFAULT 3 — "an outcome is met wherever it was filed" (plan 7d71ddcc
 * W2), on PGlite. The live defect (incident 4a741e36): four recipe proposals
 * were filed under an ambient session, approved, and the WORK session's
 * outcomes — whose `ref` named those very playbooks — stayed Pending for 7
 * days. The approval met nothing outside the session it was filed under.
 *
 * Real: the proposal door (`transitionProposal`, which owes the approval's
 * transition), the rule's match and guards (`@synap/jobs` reactions), the
 * effect's plan and apply, THE done door (`satisfyOutputsByRef`) and the slot
 * transition it owes. Stubbed: the subject edge after a delivery (its own
 * suite), the event delivery.
 *
 * NEGATIVE CONTROL: without the built-in rule (`-negctl` branch, the
 * declaration removed) the first case fails — the outcome stays pending.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async () => undefined,
    dispatchLifecycleTransition: async () => true,
  };
});
vi.mock("../../focus-sessions/subject-edge.js", () => ({
  linkSatisfiedOutputsToSubject: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  eq,
  focusSessions,
  lifecycleTransitionOutbox,
  proposals,
  transitionProposal,
} from "@synap/database";
import type { AnyTransitionPayload } from "@synap-core/types/lifecycle";
import {
  BUILT_IN_REACTIONS,
  OUTCOME_MET_REACTION_ID,
  bornReceiptTransition,
  decideReactionWrites,
  reactionMatches,
} from "@synap/jobs/utils/reactions.js";
import { meetOutcomesReactionEffect } from "../meet-outcomes-effect.js";
import { outcomeRefOfProposal } from "../../focus-sessions/satisfy-expected-output.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      type.startsWith("timestamp") && c.hasDefault ? " default now()" : "";
    const pk = c.primary
      ? type === "uuid"
        ? " primary key default gen_random_uuid()"
        : " primary key"
      : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const OWNER = "u-owner";
const OTHER = "u-other";

async function session(
  slots: unknown[],
  opts: { user?: string; status?: string; closedAt?: string | null } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, closed_at, updated_at)
     values ($1, $2, 'g', $3, $4::jsonb, '[]'::jsonb, $5::timestamptz, now())`,
    [
      id,
      opts.user ?? OWNER,
      opts.status ?? "active",
      JSON.stringify(slots),
      opts.closedAt ?? null,
    ]
  );
  return id;
}

async function proposalUnder(
  sessionId: string,
  target: { type: string; id: string }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, data, status, session_id, subject_user_id, created_by)
     values ($1, $2, $3, 'update', '{}'::jsonb, 'pending', $4, $5, $5)`,
    [id, target.type, target.id, sessionId, OWNER]
  );
  return id;
}

/** The person approves: the proposal door owes the approval's transition. */
async function approve(proposalId: string): Promise<AnyTransitionPayload> {
  await transitionProposal(db, {
    to: "approved",
    set: { reviewedBy: OWNER },
    where: eq(proposals.id, proposalId),
  });
  const r = await q<{ transition: AnyTransitionPayload }>(
    `select transition from lifecycle_transition_outbox
      where transition->>'subjectId' = $1 and transition->>'to' = 'approved'`,
    [proposalId]
  );
  return r.rows[0]!.transition;
}

/** What the reactions job does with the move, for the built-in rule alone. */
async function react(t: AnyTransitionPayload) {
  const rule = BUILT_IN_REACTIONS.find((r) => r.id === OUTCOME_MET_REACTION_ID);
  if (!rule || !reactionMatches(rule, t)) return { applied: 0 };
  const writes = await meetOutcomesReactionEffect.plan(t, rule);
  const { decided, skipped } = decideReactionWrites({
    source: t,
    planned: [{ reaction: rule, writes }],
    causedBy: null,
  });
  expect(skipped).toEqual([]);
  let applied = 0;
  for (const d of decided) {
    // D3 opt-out: meeting an outcome an approval delivered is applied.
    expect(d.mode).toBe("apply");
    const out = await meetOutcomesReactionEffect.apply(d.write, {
      transition: t,
      reaction: rule,
      cause: d.cause,
    });
    if (out.status === "applied") applied++;
  }
  return { applied };
}

const slotsOf = async (id: string) =>
  (
    await q<{ expected_outputs: Array<Record<string, unknown>> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;
const slotMoves = async (subjectId: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [subjectId]
    )
  ).rows.map((r) => r.transition);

const recipe = (playbookId: string, extra: Record<string, unknown> = {}) => ({
  kind: "proposal",
  label: "Animated video: Direct + Animatic stages",
  key: "proposal-animated",
  owner: "agent",
  ref: { kind: "playbook", id: playbookId },
  ...extra,
});

beforeAll(async () => {
  for (const t of [focusSessions, proposals, lifecycleTransitionOutbox]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);

describe("default 3: an approval meets the outcome wherever it was filed", () => {
  it("the recipe case: approved under the ambient session, the WORK session's outcome is met, with the approval's lineage and the cause", async () => {
    const playbook = randomUUID();
    const ambient = await session([]);
    const work = await session([
      recipe(playbook),
      { kind: "document", label: "Notes", key: "notes" },
    ]);
    const p = await proposalUnder(ambient, { type: "playbook", id: playbook });
    const t = await approve(p);
    // Before the rule: the approval met nothing in the work session.
    expect((await slotsOf(work))[0]!.status ?? "pending").toBe("pending");

    expect(await react(t)).toEqual({ applied: 1 });
    const [met, notes] = await slotsOf(work);
    expect(met).toMatchObject({ status: "done", satisfiedByProposalId: p });
    expect(notes!.status ?? "pending").toBe("pending");
    // History: the slot moved because the proposal moved.
    expect(await slotMoves(`${work}/proposal-animated`)).toEqual([
      expect.objectContaining({
        subjectType: "slot",
        from: "pending",
        to: "done",
        actorKind: "system",
        proposalId: p,
        cause: {
          reactionId: OUTCOME_MET_REACTION_ID,
          transitionId: t.transitionId,
          chainId: t.transitionId,
          depth: 1,
        },
      }),
    ]);
    // Idempotent: a redelivered approval meets nothing twice.
    expect(await react(t)).toEqual({ applied: 0 });
    expect(await slotMoves(`${work}/proposal-animated`)).toHaveLength(1);
  });

  it("a receipt BORN auto_approved (an agent's write a rule let through) meets it too: its door queues the job, which reads it as the approval", async () => {
    const playbook = randomUUID();
    const ambient = await session([]);
    const work = await session([recipe(playbook)]);
    const id = randomUUID();
    // Inserted already decided, as permission-check files a receipt: no
    // transition is owed for it.
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, data, status, session_id, subject_user_id, created_by, agent_user_id, created_at)
       values ($1, 'playbook', $2, 'update', '{}'::jsonb, 'auto_approved', $3, $4, 'agent-1', 'agent-1', now())`,
      [id, playbook, ambient, OWNER]
    );
    expect(
      (
        await q(
          `select 1 from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
          [id]
        )
      ).rows
    ).toEqual([]);
    const [row] = (
      await q<Record<string, unknown>>(
        `select id, status, proposal_type as "proposalType", target_type as "targetType", target_id as "targetId",
                session_id as "sessionId", workspace_id as "workspaceId", subject_user_id as "subjectUserId",
                created_by as "createdBy", agent_user_id as "agentUserId", created_at as "createdAt"
           from proposals where id = $1`,
        [id]
      )
    ).rows;
    const t = bornReceiptTransition(row as never);
    expect(t).not.toBeNull();
    expect(await react(t!)).toEqual({ applied: 1 });
    expect((await slotsOf(work))[0]).toMatchObject({
      status: "done",
      satisfiedByProposalId: id,
    });
    expect((await slotMoves(`${work}/proposal-animated`))[0]).toMatchObject({
      cause: {
        reactionId: OUTCOME_MET_REACTION_ID,
        transitionId: id,
        depth: 1,
      },
    });
  });

  it("meets it in EVERY session of the owner that declares it, and never another person's", async () => {
    const doc = randomUUID();
    const a = await session([
      recipe(doc, { kind: "document", ref: { kind: "document", id: doc } }),
    ]);
    const b = await session([
      recipe(doc, { kind: "document", ref: { kind: "document", id: doc } }),
    ]);
    const theirs = await session(
      [recipe(doc, { kind: "document", ref: { kind: "document", id: doc } })],
      { user: OTHER }
    );
    const t = await approve(
      await proposalUnder(a, { type: "document", id: doc })
    );
    expect(await react(t)).toEqual({ applied: 2 });
    expect((await slotsOf(a))[0]!.status).toBe("done");
    expect((await slotsOf(b))[0]!.status).toBe("done");
    expect((await slotsOf(theirs))[0]!.status ?? "pending").toBe("pending");
  });

  it("matches the ref's id in any case, and a session closed within the window", async () => {
    const playbook = randomUUID();
    const upper = await session([recipe(playbook.toUpperCase())]);
    const justClosed = await session([recipe(playbook)], {
      status: "closed",
      closedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const t = await approve(
      await proposalUnder(await session([]), { type: "playbook", id: playbook })
    );
    expect(await react(t)).toEqual({ applied: 2 });
    expect((await slotsOf(upper))[0]!.status).toBe("done");
    expect((await slotsOf(justClosed))[0]!.status).toBe("done");
  });

  it("never meets the person's own outcome, one a criterion checks, a withdrawn one, or one in an ended session", async () => {
    const playbook = randomUUID();
    const persons = await session([recipe(playbook, { owner: "human" })]);
    const checked = await session([recipe(playbook)]);
    await q(`update focus_sessions set criteria = $2::jsonb where id = $1`, [
      checked,
      JSON.stringify([
        {
          key: "proposal-animated",
          statement: "The recipe is right",
          check: { kind: "judge" },
        },
      ]),
    ]);
    const withdrawn = await session([
      recipe(playbook, { retiredAt: "2026-11-01T00:00:00Z" }),
    ]);
    const cancelled = await session([recipe(playbook)], {
      status: "cancelled",
    });
    const longClosed = await session([recipe(playbook)], {
      status: "closed",
      closedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    const t = await approve(
      await proposalUnder(await session([]), { type: "playbook", id: playbook })
    );
    expect(await react(t)).toEqual({ applied: 0 });
    for (const id of [persons, checked, withdrawn, cancelled, longClosed]) {
      expect((await slotsOf(id))[0]!.status ?? "pending").toBe("pending");
    }
  });

  it("a rejection meets nothing, and a target no outcome can point at is not a ref", async () => {
    const playbook = randomUUID();
    const work = await session([recipe(playbook)]);
    const p = await proposalUnder(work, { type: "playbook", id: playbook });
    await transitionProposal(db, {
      to: "rejected",
      set: { reviewedBy: OWNER },
      where: eq(proposals.id, p),
    });
    const [t] = (
      await q<{ transition: AnyTransitionPayload }>(
        `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
        [p]
      )
    ).rows.map((r) => r.transition);
    expect(await react(t!)).toEqual({ applied: 0 });
    expect((await slotsOf(work))[0]!.status ?? "pending").toBe("pending");
    expect(
      outcomeRefOfProposal({ targetType: "focus_session", targetId: "x" })
    ).toBeNull();
    expect(
      outcomeRefOfProposal({ targetType: "playbook", targetId: "x" })
    ).toEqual({
      kind: "playbook",
      id: "x",
    });
  });
});
