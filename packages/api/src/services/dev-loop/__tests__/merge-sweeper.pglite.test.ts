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
  evaluations: [] as Array<Record<string, unknown>>,
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
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.perm.push(opts);
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
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { sweepMergedPullRequest, allOutcomesMet } from "../merge-sweeper.js";
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
  ...over,
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

  it("reports allOutcomesMet when the merge was the last open outcome", async () => {
    const id = await seed([
      prSlot(302),
      { kind: "document", label: "Spec", key: "spec", status: "done" },
      {
        kind: "document",
        label: "Dropped",
        key: "dropped",
        retiredAt: "2026-10-01T00:00:00Z",
      },
    ]);
    const [o] = await sweepMergedPullRequest({
      userId: USER,
      event: merged({
        number: 302,
        url: "https://github.com/Synap-core/backend/pull/302",
      }),
    });
    expect(o).toMatchObject({
      sessionId: id,
      result: "completed",
      allOutcomesMet: true,
    });
  });

  it("does not report allOutcomesMet while another outcome is open", async () => {
    await seed([prSlot(303), { kind: "document", label: "Spec", key: "spec" }]);
    const [o] = await sweepMergedPullRequest({
      userId: USER,
      event: merged({
        number: 303,
        url: "https://github.com/Synap-core/backend/pull/303",
      }),
    });
    expect(o!.result).toBe("completed");
    expect(o!.allOutcomesMet).toBeUndefined();
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
      })
    ).toEqual({ status: "ignored", eventType: "ci.finished" });
  });
});

describe("allOutcomesMet (pure)", () => {
  it("needs at least one live outcome, all done", () => {
    expect(allOutcomesMet([])).toBe(false);
    expect(allOutcomesMet([{ status: "done" }, { retiredAt: "x" }])).toBe(true);
    expect(allOutcomesMet([{ status: "done" }, {}])).toBe(false);
  });
});
