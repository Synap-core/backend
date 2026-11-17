/**
 * THE REACTIONS REACTOR on PGlite (plan 7d71ddcc W2): one deduped job per
 * move, the matching rules applied through their targets' doors with a
 * `cause`, and every outcome logged — applied, proposed, or skipped with why.
 *
 * Real: `setRunStatus`, `setSessionStatus` (the doors and their outbox),
 * the hold's wait-ref check, the reaction log (`events`). Stubbed: the event
 * delivery (`@synap/events`), and — for the guard cases only — an effect, so
 * a conflict or a done move can be planned on purpose.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

vi.mock("@synap/events", () => ({
  dispatchLifecycleTransition: vi.fn(async () => true),
  emitSideEffects: vi.fn(async () => undefined),
  registerReactor: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  events,
  focusSessions,
  lifecycleTransitionOutbox,
  playbookRuns,
} from "@synap/database/schema";
import { db, setRunStatus } from "@synap/database";
import {
  REACTIONS_QUEUE,
  handleReactions,
  reactionsReactor,
} from "./reactions.js";
import {
  pauseSessionEffect,
  registerReactionEffect,
  resetReactionEffectsForTests,
  slotTheRunWaitsOn,
  type ReactionEffect,
} from "../utils/reaction-effects.js";
import {
  registerReactionSource,
  registerReactionStateSource,
  resetReactionRegistryForTests,
  type ReactionDeclaration,
} from "../utils/reactions.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      type.startsWith("timestamp") && c.hasDefault ? " default now()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const STOPPED = "builtin:stopped-run-needs-you";
const ASK = {
  kind: "decision",
  label: "Keep the run going",
  key: "keep-the-run-going",
  owner: "human",
  status: "pending",
  owedSince: "2026-11-17T10:00:00.000Z",
};

async function session(
  slots: unknown[] = [ASK],
  status = "active"
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, updated_at)
     values ($1, 'u1', 'g', $2, $3::jsonb, now())`,
    [id, status, JSON.stringify(slots)]
  );
  return id;
}

async function run(sessionId: string, status = "running"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, status, created_by, executor)
     values ($1, $2, $3, $4, 'u1', 'is-agent')`,
    [id, randomUUID(), sessionId, status]
  );
  return id;
}

/** The run stops early and asks the person (wave 0's park): its transition. */
async function park(runId: string, cause?: Record<string, unknown>) {
  const { transitions } = await setRunStatus(db, {
    runId,
    from: "running",
    to: "waiting_on_you",
    actor: { kind: "system" },
    ...(cause ? { cause: cause as never } : {}),
  });
  return transitions[0]!;
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.status;
const lastOwed = async (id: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox
        where transition->>'subjectId' = $1
        order by (transition->>'recordedAt') desc limit 1`,
      [id]
    )
  ).rows[0]?.transition;
const logOf = async (sourceTransitionId: string) =>
  (
    await q<{
      type: string;
      subject_id: string;
      data: Record<string, unknown>;
    }>(
      `select type, subject_id, data from events
        where subject_type = 'reaction' and data->>'sourceTransitionId' = $1`,
      [sourceTransitionId]
    )
  ).rows;

beforeAll(async () => {
  for (const t of [
    events,
    focusSessions,
    lifecycleTransitionOutbox,
    playbookRuns,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);

afterEach(() => {
  resetReactionRegistryForTests();
  resetReactionEffectsForTests();
});

describe("the reactor", () => {
  it("queues ONE job per move some rule listens to, deduped on the move's id", async () => {
    const boss = { send: vi.fn(async () => "job") };
    const payload = {
      subjectType: "playbook_run",
      action: "transition",
      subjectId: "r1",
      userId: "u1",
      eventId: "t-9",
      data: { transitionId: "t-9", to: "waiting_on_you", category: "paused" },
    };
    expect(reactionsReactor.match!(payload as never)).toBe(true);
    await reactionsReactor.handler(payload as never, { boss: boss as never });
    expect(boss.send).toHaveBeenCalledWith(
      REACTIONS_QUEUE,
      { transitionId: "t-9" },
      { singletonKey: "reaction:t-9" }
    );
    // Not a move, or a move no rule listens to: no job at all.
    expect(
      reactionsReactor.match!({ ...payload, action: "update" } as never)
    ).toBe(false);
    expect(
      reactionsReactor.match!({ ...payload, subjectType: "track" } as never)
    ).toBe(false);
  });
});

describe("default 4: a run that stops early goes to Needs you", () => {
  it("pauses the run's session, held on the person until they answer the ask, with the run's move as its cause", async () => {
    const s = await session();
    const r = await run(s);
    const t = await park(r);

    const out = await handleReactions({ transitionId: t.transitionId });
    expect(out).toEqual({ applied: 1, proposed: 0, skipped: 0 });
    expect(await statusOf(s)).toBe("paused");
    expect(await lastOwed(s)).toMatchObject({
      subjectType: "focus_session",
      from: "active",
      to: "paused",
      category: "paused",
      actorKind: "system",
      hold: {
        on: "person",
        until: { moves: `answer:${s}/keep-the-run-going` },
      },
      cause: {
        reactionId: STOPPED,
        transitionId: t.transitionId,
        chainId: t.transitionId,
        depth: 1,
      },
    });
    const log = await logOf(t.transitionId);
    expect(log).toEqual([
      expect.objectContaining({
        type: "reaction.applied",
        subject_id: STOPPED,
        data: expect.objectContaining({
          target: `focus_session:${s}`,
          to: "paused",
          depth: 1,
        }),
      }),
    ]);
    // A redelivered move moves nothing twice: the session is no longer active.
    expect(await handleReactions({ transitionId: t.transitionId })).toEqual({
      applied: 0,
      proposed: 0,
      skipped: 0,
    });
  });

  it("leaves a session that owes the person nothing, or is not at work, where it stands", async () => {
    const nothingOwed = await session([
      { kind: "document", label: "Doc", key: "doc" },
    ]);
    const t1 = await park(await run(nothingOwed));
    expect(
      (await handleReactions({ transitionId: t1.transitionId })).applied
    ).toBe(0);
    expect(await statusOf(nothingOwed)).toBe("active");

    const gated = await session([ASK], "paused");
    const t2 = await park(await run(gated));
    expect(
      (await handleReactions({ transitionId: t2.transitionId })).applied
    ).toBe(0);
    expect(await logOf(t2.transitionId)).toEqual([]);
  });

  it("is a rule like any other: paused by its owner, it is skipped and the log says so", async () => {
    registerReactionStateSource(async () => new Map([[STOPPED, false]]));
    const s = await session();
    const t = await park(await run(s));
    expect(await handleReactions({ transitionId: t.transitionId })).toEqual({
      applied: 0,
      proposed: 0,
      skipped: 1,
    });
    expect(await statusOf(s)).toBe("active");
    expect(await logOf(t.transitionId)).toEqual([
      expect.objectContaining({
        type: "reaction.skipped",
        data: expect.objectContaining({ code: "paused" }),
      }),
    ]);
  });

  it("a move another rule made does not fire it (it does not chain)", async () => {
    const s = await session();
    const t = await park(await run(s), {
      reactionId: "builtin:outcome-met-where-filed",
      transitionId: randomUUID(),
      chainId: "chain-1",
      depth: 1,
    });
    const out = await handleReactions({ transitionId: t.transitionId });
    expect(out.skipped).toBe(1);
    expect(await statusOf(s)).toBe("active");
    expect((await logOf(t.transitionId))[0]!.data).toMatchObject({
      code: "not_chained",
      chainId: "chain-1",
      depth: 2,
    });
  });

  it("a person's move wins: the compare-and-set finds another status and writes nothing", async () => {
    const s = await session();
    const [write] = await pauseSessionEffect.plan(
      await park(await run(s)),
      {} as ReactionDeclaration
    );
    // The person closed it between the plan and the write.
    await q(`update focus_sessions set status = 'closed' where id = $1`, [s]);
    const out = await pauseSessionEffect.apply(write!, {
      transition: {} as never,
      reaction: {} as never,
      cause: { reactionId: STOPPED, transitionId: "t", chainId: "t", depth: 1 },
    });
    expect(out).toEqual({
      status: "moved_meanwhile",
      reason: "The session is no longer active.",
    });
    expect(await statusOf(s)).toBe("closed");
  });

  it("waits on the newest ask the session owes the person", () => {
    expect(
      slotTheRunWaitsOn([
        { ...ASK, key: "old", label: "Old", owedSince: "2026-11-01T00:00:00Z" },
        { kind: "document", label: "Agent's", key: "agents" },
        { ...ASK, key: "new", label: "New", owedSince: "2026-11-10T00:00:00Z" },
        {
          ...ASK,
          key: "done",
          status: "done",
          owedSince: "2026-11-12T00:00:00Z",
        },
      ])
    ).toEqual({ key: "new", label: "New" });
    expect(slotTheRunWaitsOn(null)).toBeNull();
  });
});

describe("the guards, end to end (a stubbed effect plans on purpose)", () => {
  const rule = (id: string, over: Partial<ReactionDeclaration> = {}) =>
    ({
      id,
      title: `Rule ${id}`,
      when: { subjectType: "playbook_run", to: ["waiting_on_you"] },
      via: { link: "run_session" },
      do: { effect: "meet_outcomes" },
      order: 1,
      source: "declared",
      enabled: true,
      ...over,
    }) satisfies ReactionDeclaration;

  function stub(
    plan: ReactionEffect["plan"],
    extra: Partial<ReactionEffect> = {}
  ): ReactionEffect & { applied: unknown[] } {
    const applied: unknown[] = [];
    const effect = {
      key: "meet_outcomes" as const,
      plan,
      async apply(w: unknown) {
        applied.push(w);
        return { status: "applied" as const, transitionIds: [] };
      },
      applied,
      ...extra,
    };
    registerReactionEffect(effect);
    return effect;
  }

  const target = (id: string, to: string, toCategory = "active") => ({
    target: { subjectType: "entity" as const, subjectId: id },
    to,
    toCategory: toCategory as never,
    expectedFrom: "open",
    ownerUserId: "u1",
    detail: {},
  });

  it("two rules writing one thing with different values: both logged as a conflict, nothing applied", async () => {
    registerReactionSource({
      id: "test",
      subjectTypes: ["playbook_run"],
      list: async () => [rule("a"), rule("b")],
    });
    const effect = stub(async (_t, r) => [
      target("e1", r.id === "a" ? "shipped" : "archived"),
    ]);
    const t = await park(await run(await session([])));
    const out = await handleReactions({ transitionId: t.transitionId });
    expect(effect.applied).toEqual([]);
    expect(out.applied).toBe(0);
    const log = await logOf(t.transitionId);
    expect(log.map((l) => [l.subject_id, l.data.code])).toEqual(
      expect.arrayContaining([
        ["a", "conflict"],
        ["b", "conflict"],
      ])
    );
  });

  it("D3: a move into done is PROPOSED; an effect that cannot propose skips it, logged", async () => {
    registerReactionSource({
      id: "test",
      subjectTypes: ["playbook_run"],
      list: async () => [rule("done-mover")],
    });
    const cannot = stub(async () => [target("e2", "shipped", "done")]);
    const t1 = await park(await run(await session([])));
    expect(await handleReactions({ transitionId: t1.transitionId })).toEqual({
      applied: 0,
      proposed: 0,
      skipped: 1,
    });
    expect(cannot.applied).toEqual([]);
    expect((await logOf(t1.transitionId))[0]!.data).toMatchObject({
      code: "needs_proposal",
    });

    const proposed: unknown[] = [];
    const can = stub(async () => [target("e3", "shipped", "done")], {
      async propose(w, ctx) {
        proposed.push({ w, cause: ctx.cause });
        return { status: "proposed", proposalId: "p-1" };
      },
    });
    const t2 = await park(await run(await session([])));
    expect(await handleReactions({ transitionId: t2.transitionId })).toEqual({
      applied: 0,
      proposed: 1,
      skipped: 0,
    });
    expect(can.applied).toEqual([]);
    expect(proposed).toEqual([
      expect.objectContaining({
        cause: expect.objectContaining({ reactionId: "done-mover", depth: 1 }),
      }),
    ]);
    expect(await logOf(t2.transitionId)).toEqual([
      expect.objectContaining({
        type: "reaction.proposed",
        data: expect.objectContaining({ proposalId: "p-1" }),
      }),
    ]);
  });

  it("an effect whose door is not in this process is skipped and logged, never guessed", async () => {
    resetReactionEffectsForTests(); // meet_outcomes is api-side: unfilled here
    registerReactionSource({
      id: "test",
      subjectTypes: ["playbook_run"],
      list: async () => [rule("api-side", { order: 99 })],
    });
    const t = await park(await run(await session([])));
    await handleReactions({ transitionId: t.transitionId });
    expect(await logOf(t.transitionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_id: "api-side",
          data: expect.objectContaining({ code: "effect_unavailable" }),
        }),
      ])
    );
  });

  it("a write that throws is logged and fails the job (retried), after the others ran", async () => {
    registerReactionSource({
      id: "test",
      subjectTypes: ["playbook_run"],
      list: async () => [rule("boom")],
    });
    stub(async () => [target("e4", "x")], {
      async apply() {
        throw new Error("door down");
      },
    });
    const s = await session();
    const t = await park(await run(s));
    await expect(
      handleReactions({ transitionId: t.transitionId })
    ).rejects.toThrow("door down");
    // Default 4 still ran in the same job.
    expect(await statusOf(s)).toBe("paused");
    expect(
      (await logOf(t.transitionId)).map((l) => l.data.code).sort()
    ).toEqual(["applied", "failed"]);
  });
});
