/**
 * The merge sweeper, end to end through the REAL session write door
 * (plan v5 T2): `dev.pr_merged` → the PR resolves to its session(s) → the
 * outcome that IS the PR is completed by `updateFocusSession({completeOutput})`
 * (claim + the slot's own ref = the evidence verdict) → the criteria about it
 * are re-checked → "every outcome met" is reported.
 *
 * Real: the resolver's queries, `updateFocusSession`, the evidence verdict
 * (`satisfyClaimsByEvidence`), against PGlite. Stubbed, and why: the
 * governance gate (`checkPermissionOrPropose` — its verdict is the input under
 * test: granted vs proposed, and the actor it is asked about), the grading
 * door (`evaluateSession` — asserted on what it is ASKED; its own filter has
 * its own test), the event fan-out.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  perm: [] as Array<Record<string, unknown>>,
  verdict: { granted: true } as Record<string, unknown>,
  throwOnce: false,
  evaluations: [] as Array<Record<string, unknown>>,
  notices: [] as Array<{ sessionId: string; content: string; key: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Rung 0 of the real gate is the key's grant (`grantWriteDenial` on the
    // request's ambient grant) — kept REAL, so a sweep outside the posting
    // key's grant is denied exactly as the gate denies it (F1). The rest of
    // the ladder is the stubbed verdict.
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.perm.push(opts);
      if (h.throwOnce) {
        h.throwOnce = false;
        throw new Error("transient db error");
      }
      const { grantWriteDenial } =
        await import("../../../utils/grant-write-check.js");
      const denial = await grantWriteDenial({
        subjectType: opts.subjectType as string,
        action: opts.action as string,
        workspaceId: (opts.workspaceId as string | undefined) ?? null,
        data: opts.data as Record<string, unknown>,
      });
      if (denial) return { denied: true, reason: denial };
      return h.verdict;
    },
  };
});
vi.mock(
  "../../focus-sessions/evaluations/evaluate.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      evaluateSession: async (params: Record<string, unknown>) => {
        h.evaluations.push(params);
        return { status: "evaluated", results: [], resumed: false };
      },
    };
  }
);
// The room door (`postSessionNotice`) has its own tests; here it records what
// the sweep ASKED it to say, to which session, under which idempotency key.
vi.mock("../../agent-dispatch/binding-call.js", () => ({
  postSessionNotice: async (
    sessionId: string,
    content: string,
    key: string
  ) => {
    h.notices.push({ sessionId, content, key });
    return true;
  },
}));
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { sweepMergedPullRequest } from "../merge-sweeper.js";
import { resolvePullRequestSessions } from "../pr-session-resolver.js";
import { runDevLoopObservation } from "../run-observation.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = "agent-ci";
const URL255 = "https://github.com/Synap-core/backend/pull/255";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seed(
  slots: unknown[],
  opts: { user?: string; criteria?: unknown[]; status?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', $5, $3::jsonb, $4::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [
      id,
      opts.user ?? USER,
      JSON.stringify(slots),
      JSON.stringify(opts.criteria ?? []),
      opts.status ?? "active",
    ]
  );
  return id;
}

const stored = (id: string) =>
  q<{ expected_outputs: Array<Record<string, unknown>> }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!.expected_outputs);

const prSlot = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: "pull_request",
  label: `PR backend #${n}`,
  key: `pr-backend-${n}`,
  ref: { url: `https://github.com/Synap-core/backend/pull/${n}` },
  ...extra,
});

const merged = (over: Record<string, unknown> = {}) => ({
  repo: "Synap-core/backend",
  number: 255,
  url: URL255,
  base: "main",
  intoDefault: true,
  ...over,
});
const prUrl = (n: number) => `https://github.com/Synap-core/backend/pull/${n}`;
const job = (
  eventType: string,
  data: Record<string, unknown>,
  grant: unknown = null
) => ({
  eventType,
  data,
  userId: USER,
  producerAgentUserId: AGENT,
  eventId: "ev-x",
  grant: grant as never,
});

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
}, 120_000);
afterAll(async () => {
  await h.client?.close();
});

describe("the merge sweeper (dev.pr_merged → the PR outcome is met)", () => {
  beforeEach(() => {
    h.perm.length = 0;
    h.evaluations.length = 0;
    h.verdict = { granted: true };
  });

  it("completes the outcome whose ref is the PR — done by EVIDENCE, through the governed door, as the producer", async () => {
    const id = await seed([
      prSlot(255),
      { kind: "document", label: "Notes", key: "notes" },
    ]);
    const out = await sweepMergedPullRequest({
      userId: USER,
      producerAgentUserId: AGENT,
      event: merged(),
    });
    expect(out).toEqual([
      {
        sessionId: id,
        slotKey: "pr-backend-255",
        via: "outcome_ref",
        result: "completed",
      },
    ]);
    const slots = await stored(id);
    expect(slots[0]).toMatchObject({
      status: "done",
      claimedDone: true,
      satisfiedByEvidence: { kind: "ref", id: URL255 },
    });
    // The sibling outcome is untouched.
    expect(slots[1]!.status ?? "pending").toBe("pending");
    // Governed: the ONE gate, asked about the PRODUCER agent, for a session update.
    expect(h.perm).toHaveLength(1);
    expect(h.perm[0]).toMatchObject({
      userId: USER,
      agentUserId: AGENT,
      subjectType: "focus_session",
      action: "update",
      data: { id, completeOutput: "pr-backend-255" },
    });
  });

  it("matches any spelling of the PR (repo case, a sub-page) and never #25 for #255", async () => {
    const a = await seed([
      prSlot(255, {
        ref: { url: "https://github.com/synap-core/BACKEND/pull/255/files" },
      }),
    ]);
    const near = await seed([prSlot(25), prSlot(2550)]);
    const other = await seed([
      {
        ...prSlot(255),
        ref: { url: "https://github.com/Synap-core/browser/pull/255" },
      },
    ]);
    await sweepMergedPullRequest({ userId: USER, event: merged() });
    expect((await stored(a))[0]!.status).toBe("done");
    expect((await stored(near)).map((s) => s.status ?? "pending")).toEqual([
      "pending",
      "pending",
    ]);
    expect((await stored(other))[0]!.status ?? "pending").toBe("pending");
  });

  it("is OWNER-floored: another person's session pointing at the same PR is not touched", async () => {
    const theirs = await seed([prSlot(255)], { user: OTHER });
    const out = await sweepMergedPullRequest({
      userId: USER,
      event: merged({ number: 255 }),
    });
    expect(out.some((o) => o.sessionId === theirs)).toBe(false);
    expect((await stored(theirs))[0]!.status ?? "pending").toBe("pending");
  });

  it("files a PROPOSAL and writes nothing when governance says propose", async () => {
    h.verdict = { granted: false, proposalId: "prop-1" };
    const id = await seed([prSlot(300)]);
    const out = await sweepMergedPullRequest({
      userId: USER,
      producerAgentUserId: AGENT,
      event: merged({
        number: 300,
        url: "https://github.com/Synap-core/backend/pull/300",
      }),
    });
    expect(out).toEqual([
      {
        sessionId: id,
        slotKey: "pr-backend-300",
        via: "outcome_ref",
        result: "proposed",
        proposalId: "prop-1",
      },
    ]);
    const slot = (await stored(id))[0]!;
    expect(slot.status ?? "pending").toBe("pending");
    expect(slot.claimedDone ?? false).toBe(false);
  });

  it("is idempotent: a replayed merge skips the settled outcome without a write", async () => {
    const id = await seed([prSlot(301)]);
    const ev = merged({
      number: 301,
      url: "https://github.com/Synap-core/backend/pull/301",
    });
    await sweepMergedPullRequest({ userId: USER, event: ev });
    h.perm.length = 0;
    const again = await sweepMergedPullRequest({ userId: USER, event: ev });
    expect(again).toEqual([
      {
        sessionId: id,
        slotKey: "pr-backend-301",
        via: "outcome_ref",
        result: "already_settled",
      },
    ]);
    expect(h.perm).toHaveLength(0);
  });

  it("re-checks the criteria ABOUT the merged outcome, with the merge as evidence", async () => {
    const id = await seed([prSlot(304)], {
      criteria: [
        {
          key: "merged",
          statement: "Merged",
          check: { kind: "evidence", evidenceKey: "pr-backend-304" },
        },
        { key: "docs", statement: "Docs", check: { kind: "judge" } },
      ],
    });
    await sweepMergedPullRequest({
      userId: USER,
      producerAgentUserId: AGENT,
      event: merged({
        number: 304,
        url: "https://github.com/Synap-core/backend/pull/304",
      }),
    });
    expect(h.evaluations).toHaveLength(1);
    expect(h.evaluations[0]).toMatchObject({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      kinds: ["evidence", "capability"],
      criterionKeys: ["pr-backend-304"],
      evidence: {
        "pr-backend-304": {
          passed: true,
          detail: "Merged: https://github.com/Synap-core/backend/pull/304",
        },
      },
    });
  });

  it("spends no grading call when no criterion is about the outcome", async () => {
    await seed([prSlot(305)], {
      criteria: [{ key: "docs", statement: "Docs", check: { kind: "judge" } }],
    });
    await sweepMergedPullRequest({
      userId: USER,
      event: merged({
        number: 305,
        url: "https://github.com/Synap-core/backend/pull/305",
      }),
    });
    expect(h.evaluations).toHaveLength(0);
  });
});

describe("the PR → session resolver's second join: the PR body's Pod session line", () => {
  it("falls back to the session the body names, matching the conventional key", async () => {
    const id = await seed([
      { kind: "pull_request", label: "PR", key: "pr-backend-400" },
    ]);
    const m = await resolvePullRequestSessions({
      userId: USER,
      pr: { repo: "Synap-core/backend", number: 400 },
      body: `Does a thing.\n\nPod session: ${id}`,
    });
    expect(m).toEqual([
      {
        sessionId: id,
        slotKey: "pr-backend-400",
        via: "pr_body",
        settled: false,
      },
    ]);
  });

  it("names the session with slotKey null when it never declared the PR", async () => {
    const id = await seed([{ kind: "document", label: "Spec", key: "spec" }]);
    const out = await sweepMergedPullRequest({
      userId: USER,
      event: merged({
        number: 401,
        url: "https://github.com/Synap-core/backend/pull/401",
        sessionId: id,
      }),
    });
    expect(out).toEqual([
      { sessionId: id, slotKey: null, via: "pr_body", result: "no_outcome" },
    ]);
  });

  it("refuses a body naming another person's session", async () => {
    const theirs = await seed(
      [{ kind: "pull_request", label: "PR", key: "pr-backend-402" }],
      {
        user: OTHER,
      }
    );
    const m = await resolvePullRequestSessions({
      userId: USER,
      pr: { repo: "Synap-core/backend", number: 402 },
      body: `Pod session: ${theirs}`,
    });
    expect(m).toEqual([]);
  });

  it("prefers the outcome ref over the body", async () => {
    const declared = await seed([prSlot(403)]);
    const named = await seed([{ kind: "document", label: "x", key: "x" }]);
    const m = await resolvePullRequestSessions({
      userId: USER,
      pr: { repo: "Synap-core/backend", number: 403 },
      body: `Pod session: ${named}`,
    });
    expect(m.map((x) => [x.sessionId, x.via])).toEqual([
      [declared, "outcome_ref"],
    ]);
  });
});

describe("runDevLoopObservation (the job's runner)", () => {
  it("sweeps a dev.pr_merged and ignores what the pod does not act on", async () => {
    const id = await seed([prSlot(500)]);
    const r = await runDevLoopObservation({
      eventType: "dev.pr_merged",
      data: merged({
        number: 500,
        url: "https://github.com/Synap-core/backend/pull/500",
      }),
      userId: USER,
      producerAgentUserId: null,
      eventId: "ev-1",
      grant: null,
    });
    expect(r).toMatchObject({
      status: "swept",
      outcomes: [{ sessionId: id, result: "completed" }],
    });
    expect(
      await runDevLoopObservation({
        eventType: "ci.finished",
        data: {},
        userId: USER,
        producerAgentUserId: null,
        eventId: "ev-2",
        grant: null,
      })
    ).toEqual({ status: "ignored", eventType: "ci.finished" });
  });
});

describe("only a merge into the DEFAULT branch delivers the PR (founder F3)", () => {
  beforeEach(() => {
    h.perm.length = 0;
    h.verdict = { granted: true };
  });

  it("a stacked PR merged into its parent branch completes nothing: not_default_base", async () => {
    const id = await seed([prSlot(600)]);
    const out = await sweepMergedPullRequest({
      userId: USER,
      producerAgentUserId: AGENT,
      event: merged({
        number: 600,
        url: prUrl(600),
        base: "feat/parent",
        intoDefault: false,
      }),
    });
    expect(out).toEqual([
      {
        sessionId: id,
        slotKey: "pr-backend-600",
        via: "outcome_ref",
        result: "not_default_base",
        reason: "Merged into feat/parent, not the default branch.",
      },
    ]);
    expect(h.perm).toHaveLength(0);
    expect((await stored(id))[0]!.status ?? "pending").toBe("pending");
    expect(h.evaluations).toHaveLength(0);
  });

  it("a producer that does not say intoDefault is not known to be the default: fail closed", async () => {
    const id = await seed([prSlot(601)]);
    const out = await sweepMergedPullRequest({
      userId: USER,
      event: merged({ number: 601, url: prUrl(601), intoDefault: undefined }),
    });
    expect(out[0]).toMatchObject({ sessionId: id, result: "not_default_base" });
    expect((await stored(id))[0]!.status ?? "pending").toBe("pending");
  });
});

describe("a PR closed WITHOUT merging retires its outcome (founder F2)", () => {
  beforeEach(() => {
    h.perm.length = 0;
    h.verdict = { granted: true };
  });

  it("dev.pr_closed withdraws the outcome through the governed door, as the producer", async () => {
    const id = await seed([
      prSlot(700),
      { kind: "document", label: "N", key: "n" },
    ]);
    const r = await runDevLoopObservation(
      job("dev.pr_closed", merged({ number: 700, url: prUrl(700) }))
    );
    expect(r).toEqual({
      status: "swept",
      outcomes: [
        {
          sessionId: id,
          slotKey: "pr-backend-700",
          via: "outcome_ref",
          result: "retired",
        },
      ],
    });
    const slots = await stored(id);
    expect(slots[0]).toMatchObject({ retiredReason: "withdrawn" });
    expect(slots[0]!.retiredAt).toBeTruthy();
    expect(slots[0]!.status ?? "pending").not.toBe("done");
    expect(slots[1]!.retiredAt ?? null).toBeNull();
    expect(h.perm[0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "focus_session",
      action: "update",
      data: { id, retireOutput: "pr-backend-700" },
    });
  });

  it("a delivered outcome is never withdrawn by a later close", async () => {
    const id = await seed([prSlot(701, { status: "done" })]);
    const r = await runDevLoopObservation(
      job("dev.pr_closed", merged({ number: 701, url: prUrl(701) }))
    );
    expect(r).toMatchObject({
      outcomes: [{ sessionId: id, result: "already_settled" }],
    });
    expect(h.perm).toHaveLength(0);
  });
});

describe("the sweep runs inside the POSTING KEY'S GRANT (founder F1)", () => {
  beforeEach(() => {
    h.perm.length = 0;
    h.verdict = { granted: true };
  });

  it("a key allowed only event.create is DENIED — the outcome is never completed", async () => {
    const id = await seed([prSlot(800)]);
    const r = await runDevLoopObservation(
      job("dev.pr_merged", merged({ number: 800, url: prUrl(800) }), {
        scopes: [{ permissions: ["event.create"] }],
        clientId: "app-obs",
      })
    );
    expect(r).toMatchObject({
      status: "swept",
      outcomes: [{ sessionId: id, result: "denied" }],
    });
    const out = (r as { outcomes: Array<{ reason?: string }> }).outcomes[0]!;
    expect(out.reason).toMatch(/grant does not allow "session\.update"/);
    const slot = (await stored(id))[0]!;
    expect(slot.status ?? "pending").toBe("pending");
    expect(slot.claimedDone ?? false).toBe(false);
  });

  it("a key whose grant allows the session update completes it (the grant is the bound, not a blanket deny)", async () => {
    const id = await seed([prSlot(801)]);
    const r = await runDevLoopObservation(
      job("dev.pr_merged", merged({ number: 801, url: prUrl(801) }), {
        scopes: [{ permissions: ["event.create", "session.update"] }],
        clientId: null,
      })
    );
    expect(r).toMatchObject({
      outcomes: [{ sessionId: id, result: "completed" }],
    });
  });

  it("an event.create-only key cannot retire an outcome either", async () => {
    const id = await seed([prSlot(802)]);
    const r = await runDevLoopObservation(
      job("dev.pr_closed", merged({ number: 802, url: prUrl(802) }), {
        scopes: [{ permissions: ["event.create"] }],
        clientId: null,
      })
    );
    expect(r).toMatchObject({ outcomes: [{ result: "denied" }] });
    expect((await stored(id))[0]!.retiredAt ?? null).toBeNull();
  });
});

describe("a transient failure fails the job, and the retry finishes it (S2)", () => {
  beforeEach(() => {
    h.perm.length = 0;
    h.verdict = { granted: true };
  });

  it("throws when a session's write failed; the retried job completes it and skips what settled", async () => {
    const id = await seed([prSlot(900)]);
    h.throwOnce = true;
    await expect(
      runDevLoopObservation(
        job("dev.pr_merged", merged({ number: 900, url: prUrl(900) }))
      )
    ).rejects.toThrow(/failed for .*pr-backend-900: transient db error/);
    expect((await stored(id))[0]!.status ?? "pending").toBe("pending");
    const retry = await runDevLoopObservation(
      job("dev.pr_merged", merged({ number: 900, url: prUrl(900) }))
    );
    expect(retry).toMatchObject({
      outcomes: [{ sessionId: id, result: "completed" }],
    });
  });
});

describe("the sweep's verdict is said in the session room (a denial is never silent)", () => {
  beforeEach(() => {
    h.perm.length = 0;
    h.notices.length = 0;
    h.verdict = { granted: true };
  });

  const PR_KEY = {
    scopes: [{ permissions: ["event.create", "session.update"] }],
    clientId: null,
  };
  const EVENT_ONLY_KEY = {
    scopes: [{ permissions: ["event.create"] }],
    clientId: null,
  };

  it("a merged fact meets the PR outcome, and the room says it was recorded as delivered", async () => {
    const id = await seed([prSlot(1000)]);
    const r = await runDevLoopObservation({
      ...job(
        "dev.pr_merged",
        merged({ number: 1000, url: prUrl(1000) }),
        PR_KEY
      ),
      eventId: "ev-1000",
    });
    expect(r).toMatchObject({
      outcomes: [{ sessionId: id, result: "completed" }],
    });
    expect((await stored(id))[0]).toMatchObject({
      status: "done",
      satisfiedByEvidence: { kind: "ref", id: prUrl(1000) },
    });
    expect(h.notices).toEqual([
      {
        sessionId: id,
        content:
          'Synap-core/backend#1000 merged into main: the pod recorded "pr-backend-1000" as delivered.',
        key: `dev-loop:ev-1000:${id}:pr-backend-1000`,
      },
    ]);
  });

  it("a key holding only event.create: the outcome stays open, and the room names the grant it lacks and the by-hand fallback", async () => {
    const id = await seed([prSlot(1001)]);
    const r = await runDevLoopObservation({
      ...job(
        "dev.pr_merged",
        merged({ number: 1001, url: prUrl(1001) }),
        EVENT_ONLY_KEY
      ),
      eventId: "ev-1001",
    });
    expect(r).toMatchObject({
      outcomes: [{ sessionId: id, result: "denied" }],
    });
    expect((await stored(id))[0]!.status ?? "pending").toBe("pending");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.sessionId).toBe(id);
    expect(h.notices[0]!.content).toBe(
      'Synap-core/backend#1001 merged into main, but the pod could not record "pr-backend-1001": ' +
        'This key\'s grant does not allow "session.update". ' +
        'Record it with completeOutput "pr-backend-1001", or give the key that posts PR facts the session.update grant.'
    );
  });

  it("a closed-unmerged PR says it withdrew the outcome; a replay of the same fact says nothing twice", async () => {
    const id = await seed([prSlot(1002)]);
    const closed = {
      ...job(
        "dev.pr_closed",
        merged({ number: 1002, url: prUrl(1002) }),
        PR_KEY
      ),
      eventId: "ev-1002",
    };
    await runDevLoopObservation(closed);
    expect(h.notices.map((n) => n.content)).toEqual([
      'Synap-core/backend#1002 closed without merging: the pod withdrew "pr-backend-1002".',
    ]);
    // Replayed: the slot is settled, nothing new to say.
    await runDevLoopObservation(closed);
    expect(h.notices).toHaveLength(1);
    expect((await stored(id))[0]!.retiredAt).toBeTruthy();
  });
});
