/**
 * THE waiting-on collector (dev-work plan P0.1, P0.2, P1.1) and what statusOf
 * adds (P0.3) on real SQL (PGlite):
 *
 *   - every source in ONE collector: owed slots (THE needs-you lens: a draft's
 *     ask-less slot is not waited on), pending proposals, `blocked_by`
 *     blockers, the current hold, open pull requests by their recorded state,
 *     open sub-sessions — each mark naming WHAT it waits on (`refs`);
 *   - a hold on `nobody` makes no mark; a red, merged or unrecorded PR makes
 *     none either;
 *   - statusOf carries the hold, `live` and THE next move of a session, and
 *     the continuation packet waits on what statusOf says;
 *   - a goal's waiting-on is the same collector (its open runs), counting
 *     every member's runs and naming only those the reader may read; a hold
 *     on a session the reader may not read is counted, never named;
 *   - owed slots are capped per session, so one session never crowds out
 *     another's; the next move reads every PR, not the packet's top five;
 *   - the PR states are read ONCE per rollup, however many sessions it has,
 *     with the rollup time measured before and after the new sources.
 *
 * Only `getEffectiveLifecycle` is stubbed (no lifecycle is under test).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown, prReads: 0 }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

// Counts the PR-state reads: the rollup must make one, never one per session.
vi.mock("../../dev-loop/pr-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../dev-loop/pr-state.js")>();
  return {
    ...actual,
    readPullRequestStates: (
      ...args: Parameters<typeof actual.readPullRequestStates>
    ) => {
      holder.prReads++;
      return actual.readPullRequestStates(...args);
    },
  };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import { readStatusOf } from "../status-read.js";
import { holdWaitingOnRef, readWaitingOn } from "../status-facts.js";
import { readDependencyState } from "../../links/dependency-links.js";
import { readScopeRollup } from "../status-rollup.js";

const ME = "user-me";
const OTHER = "user-other";
const W = randomUUID();
const P = randomUUID();
const G = randomUUID();
const S_WORK = randomUUID();
const S_BLOCKER = randomUUID();
const S_CHILD = randomUUID();
const S_DRAFT = randomUUID();
const S_PAUSED = randomUUID();
const S_PARKED = randomUUID();
const PROPOSAL = randomUUID();
// A team goal: my run and another member's, which I may not read.
const G_TEAM = randomUUID();
const S_MINE = randomUUID();
const S_THEIRS = randomUUID();
// One session owing many slots, one owing one; one session with six PRs.
const S_MANY = randomUUID();
const S_ONE = randomUUID();
const S_SIX = randomUUID();
const REPO = "Synap-core/backend";
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

async function session(
  id: string,
  o: {
    status?: string;
    origin?: string;
    title?: string;
    outputs?: unknown[];
    trackId?: string | null;
    userId?: string;
  } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'Do it', $7, $8, $9::jsonb, $10::jsonb, now(), now(), now())`,
    [
      id,
      o.userId ?? ME,
      W,
      P,
      o.trackId ?? null,
      o.title ?? null,
      o.status ?? "active",
      o.origin ?? "user",
      JSON.stringify(o.outputs ?? []),
      JSON.stringify({}),
    ]
  );
}

async function link(from: string, type: string, to: string) {
  await q(
    `insert into links (id, created_by, from_type, from_id, to_type, to_id, link_type, created_at)
     values ($1, $2, 'session', $3, 'session', $4, $5, now())`,
    [randomUUID(), ME, from, to, type]
  );
}

async function devEvent(type: string, data: Record<string, unknown>) {
  await q(
    `insert into events (id, type, subject_id, subject_type, data, user_id, workspace_id, timestamp)
     values ($1, $2, $3, 'pull_request', $4::jsonb, $5, $6, now())`,
    [randomUUID(), type, randomUUID(), JSON.stringify(data), ME, W]
  );
}

async function hold(subjectId: string, h: Record<string, unknown>) {
  const since = new Date().toISOString();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, now())`,
    [
      randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        subjectType: "focus_session",
        subjectId,
        to: "paused",
        category: "paused",
        userId: ME,
        workspaceId: W,
        recordedAt: since,
        hold: { resumeTo: "active", since, ...h },
      }),
    ]
  );
}

const prSlot = (n: number, extra: Record<string, unknown> = {}) => ({
  key: `pr-backend-${n}`,
  label: `backend#${n}`,
  kind: "pull_request",
  status: "pending",
  ref: { url: pr(n) },
  ...extra,
});

beforeAll(async () => {
  client = new PGlite();
  for (const t of allSchemaTables()) await client.exec(pgliteTableDdl(t));
  holder.db = drizzle(client, { schema });

  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Builder', 'personal')`,
    [W, ME]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), W, ME]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [P, ME]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'Dev work seen', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
    [G, P, ME]
  );

  // The work session: one of every source.
  await session(S_WORK, {
    title: "Status one read",
    trackId: G,
    outputs: [
      {
        key: "key",
        label: "Stripe key",
        kind: "secret",
        owner: "human",
        status: "pending",
        blockedReason: "credential",
        owedSince: new Date().toISOString(),
      },
      prSlot(1), // green → waits on the merge queue
      prSlot(2), // no check result → waits on CI
      prSlot(3), // red → the agent's own work, no wait
      prSlot(4), // merged → no wait
      prSlot(5), // nothing recorded → never guessed
      prSlot(6, { status: "done" }), // a met outcome is not open
    ],
  });
  await session(S_BLOCKER, { title: "Lane A" });
  await session(S_CHILD, { title: "Lane B" });
  await link(S_WORK, "blocked_by", S_BLOCKER);
  await link(S_CHILD, "spawned_from", S_WORK);
  // S_WORK serves the (open) goal G: work FOR it, not a wait on it.
  await q(
    `insert into links (id, created_by, from_type, from_id, to_type, to_id, link_type, created_at)
     values ($1, $2, 'session', $3, 'track', $4, 'serves', now())`,
    [randomUUID(), ME, S_WORK, G]
  );
  await q(
    `insert into proposals (id, workspace_id, created_by, session_id, proposal_type, target_type, target_id, status, data, created_at, updated_at)
     values ($1, $2, $3, $4, 'create', 'entity', $5, 'pending', '{"title":"Pricing note"}'::jsonb, now(), now())`,
    [PROPOSAL, W, ME, S_WORK, randomUUID()]
  );
  for (const n of [1, 2, 3, 4]) {
    await devEvent("dev.pr_opened", {
      repo: REPO,
      number: n,
      url: pr(n),
      sha: `${n}`.repeat(7) + "abcdef",
    });
  }
  await devEvent("ci.finished", {
    repo: REPO,
    pr: 1,
    sha: "1111111abcdef",
    workflow: "CI",
    status: "success",
  });
  await devEvent("ci.finished", {
    repo: REPO,
    pr: 3,
    sha: "3333333abcdef",
    workflow: "CI",
    status: "failure",
  });
  await devEvent("dev.pr_merged", {
    repo: REPO,
    number: 4,
    url: pr(4),
    sha: "4444444ffffff",
  });

  // An agent DRAFT (not accepted) owing a plain, ask-less deliverable: the
  // needs-you lens leaves it out, so nothing waits on it either.
  await session(S_DRAFT, {
    origin: "agent",
    outputs: [
      {
        key: "doc",
        label: "Write the brief",
        kind: "document",
        owner: "human",
        status: "pending",
        owedSince: new Date().toISOString(),
      },
    ],
  });

  // Two pauses: one waits on a person, one is parked on nobody.
  await session(S_PAUSED, {
    status: "paused",
    outputs: [{ key: "brief", label: "Brief", kind: "document" }],
  });
  await hold(S_PAUSED, {
    on: "person",
    ref: `person:${randomUUID()}`,
    reason: "the founder's go",
    reviewBy: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });
  await session(S_PARKED, { status: "paused" });
  await hold(S_PARKED, { on: "nobody", reason: null });

  // The team goal. Their run owes a slot, has a green PR and a hold whose
  // words are theirs; mine is paused until theirs moves.
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'Team goal', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
    [G_TEAM, P, ME]
  );
  await session(S_THEIRS, {
    userId: OTHER,
    status: "paused",
    title: "Their private lane",
    trackId: G_TEAM,
    outputs: [
      {
        key: "ask",
        label: "Their private ask",
        kind: "decision",
        owner: "human",
        status: "pending",
        blockedReason: "decision",
        owedSince: new Date().toISOString(),
      },
      prSlot(50),
    ],
  });
  await hold(S_THEIRS, {
    on: "person",
    ref: `person:${randomUUID()}`,
    reason: "their secret plan",
  });
  await devEvent("dev.pr_opened", {
    repo: REPO,
    number: 50,
    url: pr(50),
    sha: "5050505abcdef",
  });
  await devEvent("ci.finished", {
    repo: REPO,
    pr: 50,
    sha: "5050505abcdef",
    workflow: "CI",
    status: "success",
  });
  await session(S_MINE, {
    status: "paused",
    title: "My lane",
    trackId: G_TEAM,
  });
  await hold(S_MINE, {
    on: "agent",
    reason: "their lane first",
    until: { moves: `focus_session:${S_THEIRS}` },
  });

  // 120 older slots on one session, one newer slot on another.
  const old = new Date(Date.now() - 3_600_000).toISOString();
  await session(S_MANY, {
    outputs: Array.from({ length: 120 }, (_, i) => ({
      key: `k${i}`,
      label: `Slot ${i}`,
      kind: "document",
      owner: "human",
      status: "pending",
      owedSince: old,
    })),
  });
  await session(S_ONE, {
    outputs: [
      {
        key: "sign",
        label: "Sign the lease",
        kind: "task",
        owner: "human",
        status: "pending",
        blockedReason: "physical",
        owedSince: new Date().toISOString(),
      },
    ],
  });

  // Six PRs: five green, the sixth red — past the packet's top five.
  await session(S_SIX, {
    outputs: [61, 62, 63, 64, 65, 66].map((n) => prSlot(n)),
  });
  for (const n of [61, 62, 63, 64, 65, 66]) {
    const sha = `${n}${n}${n}abcdef`;
    await devEvent("dev.pr_opened", { repo: REPO, number: n, url: pr(n), sha });
    await devEvent("ci.finished", {
      repo: REPO,
      pr: n,
      sha,
      workflow: "CI",
      status: n === 66 ? "failure" : "success",
    });
  }
});

describe("one waiting-on collector", () => {
  it("counts every source and names what is waited on", async () => {
    const marks = await readWaitingOn({
      userId: ME,
      owed: { sessionIds: [S_WORK] },
      proposals: { sessionIds: [S_WORK] },
      blockedNodes: [{ kind: "session", id: S_WORK }],
      holds: [{ subjectType: "focus_session", subjectId: S_WORK }],
      workUnitsOf: [S_WORK],
      childrenOf: [S_WORK],
    });
    expect(marks).toEqual([
      {
        reason: "approval",
        count: 1,
        refs: [
          {
            kind: "proposal",
            id: PROPOSAL,
            label: expect.any(String),
            waitKind: "approval",
          },
        ],
      },
      {
        reason: "access",
        count: 1,
        refs: [
          { kind: "slot", id: S_WORK, label: "Stripe key", waitKind: "access" },
        ],
      },
      {
        // The open goal S_WORK SERVES is not among them: `serves` is no wait.
        reason: "another_work",
        count: 2,
        refs: [
          {
            kind: "session",
            id: S_BLOCKER,
            label: "Lane A",
            waitKind: "another_work",
          },
          {
            kind: "session",
            id: S_CHILD,
            label: "Lane B",
            waitKind: "another_work",
          },
        ],
      },
      {
        // A green PR waits on the merge queue (the bot enqueues it), not a
        // person; one with no check result waits on CI.
        reason: "external",
        count: 2,
        refs: [
          {
            kind: "pull_request",
            url: pr(1),
            label: "backend#1",
            waitKind: "merge_queue",
          },
          {
            kind: "pull_request",
            url: pr(2),
            label: "backend#2",
            waitKind: "ci",
          },
        ],
      },
    ]);
    // THE blocker read itself: the `serves` edge is neither declared nor open.
    const state = await readDependencyState(
      { kind: "session", id: S_WORK },
      ME
    );
    expect(state.declared).toEqual([{ kind: "session", id: S_BLOCKER }]);
  });

  it("a draft's ask-less slot waits on nobody: the needs-you lens", async () => {
    expect(
      await readWaitingOn({ userId: ME, owed: { sessionIds: [S_DRAFT] } })
    ).toEqual([]);
  });
});

describe("statusOf — hold, live, next move", () => {
  it("a paused session carries its hold, waits on what it names, and its next move says so", async () => {
    const [paused, parked, work] = await readStatusOf(ME, [
      S_PAUSED,
      S_PARKED,
      S_WORK,
    ]);
    expect(paused).toMatchObject({
      type: "session",
      category: "paused",
      hold: { on: "person", reason: "the founder's go" },
      // The person's id is a door, never words.
      waitingOn: [
        {
          reason: "input",
          count: 1,
          refs: [
            {
              kind: "person",
              id: expect.any(String),
              label: "the founder's go",
              waitKind: "answer",
            },
          ],
        },
      ],
      live: { status: "ok", state: "idle" },
      nextMove: {
        kind: "waiting_on_hold",
        actor: "none",
        label: "Waiting on the founder's go",
      },
    });
    // Parked on nobody: the hold is shown, nothing is waited on.
    expect(parked).toMatchObject({
      hold: { on: "nobody" },
      waitingOn: [],
      nextMove: { kind: "waiting_on_hold", label: "Paused" },
    });
    // An active session has no hold; its next move reads its PRs (red first).
    expect(work).not.toHaveProperty("hold");
    expect(work).toMatchObject({
      nextMove: { kind: "owed_slot", actor: "user" },
    });
  });

  it("the continuation packet waits on what statusOf says, from the same question", async () => {
    const { projectContinuationPacket } =
      await import("../../focus-sessions/continuation-packet.js");
    const d = holder.db as ReturnType<typeof drizzle<typeof schema>>;
    const answers = await readStatusOf(ME, [S_WORK, S_PAUSED]);
    for (const [i, id] of [S_WORK, S_PAUSED].entries()) {
      const [row] = await d
        .select()
        .from(schema.focusSessions)
        .where(eq(schema.focusSessions.id, id));
      const packet = await projectContinuationPacket(row!, {
        database: d as never,
        userId: ME,
      });
      const said = (answers[i] as { waitingOn: unknown }).waitingOn;
      // Non-vacuity: both sessions wait on something.
      expect(said).not.toEqual([]);
      expect(packet.waitingOn).toEqual({ status: "ok", marks: said });
    }
  });

  it("a goal waits on what its open runs wait on (the same collector)", async () => {
    const [goal] = await readStatusOf(ME, [G]);
    expect(goal).toMatchObject({ type: "goal" });
    const reasons = (
      goal as { waitingOn: Array<{ reason: string; count: number }> }
    ).waitingOn.map((m) => [m.reason, m.count]);
    // S_WORK is its only run: its slot, proposal, PRs and blocker.
    expect(reasons).toEqual([
      ["approval", 1],
      ["access", 1],
      ["another_work", 1],
      ["external", 2],
    ]);
  });
});

describe("what the reader may not read is counted, never named", () => {
  it("a hold on a session I may not read: its reason's words, no id, not the mover's", async () => {
    const marks = await readWaitingOn({
      userId: ME,
      holds: [{ subjectType: "focus_session", subjectId: S_THEIRS }],
    });
    expect(marks).toEqual([
      {
        reason: "input",
        count: 1,
        refs: [
          { kind: "thing", label: expect.any(String), waitKind: "answer" },
        ],
      },
    ]);
    expect(JSON.stringify(marks)).not.toContain("their secret plan");
  });

  it("a team goal counts every member's runs and names only mine", async () => {
    const [goal] = await readStatusOf(ME, [G_TEAM]);
    const marks = (
      goal as { waitingOn: Array<{ reason: string; count: number }> }
    ).waitingOn;
    // Their owed slot and their hold (input), their green PR (external),
    // my hold (another_work): every member's, as the criterion marks count.
    expect(marks.map((m) => [m.reason, m.count])).toEqual([
      ["input", 2],
      ["another_work", 1],
      ["external", 1],
    ]);
    const said = JSON.stringify(marks);
    for (const theirs of [
      S_THEIRS,
      "Their private ask",
      "Their private lane",
      "their secret plan",
      pr(50),
    ]) {
      expect(said).not.toContain(theirs);
    }
    // My own hold is named, in my words.
    expect(said).toContain("their lane first");
  });
});

describe("caps and the next move see everything", () => {
  it("owed slots are capped per session: one never crowds another out", async () => {
    const marks = await readWaitingOn({
      userId: ME,
      owed: { sessionIds: [S_MANY, S_ONE] },
    });
    expect(marks.map((m) => [m.reason, m.count])).toEqual([
      ["input", 100],
      ["external", 1],
    ]);
  });

  it("a red PR past the packet's top five is still the next move", async () => {
    const { projectContinuationPacket } =
      await import("../../focus-sessions/continuation-packet.js");
    const d = holder.db as ReturnType<typeof drizzle<typeof schema>>;
    const [row] = await d
      .select()
      .from(schema.focusSessions)
      .where(eq(schema.focusSessions.id, S_SIX));
    const packet = await projectContinuationPacket(row!, {
      database: d as never,
      userId: ME,
    });
    expect(packet.workUnits).toMatchObject({ status: "ok", total: 6 });
    expect(
      packet.workUnits.status === "ok" && packet.workUnits.items
    ).toHaveLength(5);
    expect(packet.nextMove).toMatchObject({
      kind: "pull_request",
      reasonCode: "checks_failed",
      url: pr(66),
    });
  });
});

describe("the rollup reads PR states once", () => {
  it("one PR-state read for many sessions; time measured before and after", async () => {
    const many = Array.from({ length: 40 }, () => randomUUID());
    for (const [i, id] of many.entries()) {
      await session(id, { outputs: [prSlot(100 + i)] });
      await devEvent("dev.pr_opened", {
        repo: REPO,
        number: 100 + i,
        url: pr(100 + i),
      });
    }
    const before = {
      userId: ME,
      owed: { sessionIds: many },
      proposals: { sessionIds: many },
      blockedNodes: many.map((id) => ({ kind: "session" as const, id })),
    };
    let t = performance.now();
    await readWaitingOn(before);
    const msBefore = performance.now() - t;

    holder.prReads = 0;
    t = performance.now();
    const after = await readWaitingOn({
      ...before,
      holds: many.map((id) => ({
        subjectType: "focus_session" as const,
        subjectId: id,
      })),
      workUnitsOf: many,
    });
    const msAfter = performance.now() - t;
    expect(holder.prReads).toBe(1);
    expect(after).toEqual([
      expect.objectContaining({ reason: "external", count: 40 }),
    ]);
    expect(after[0]!.refs).toHaveLength(5);

    holder.prReads = 0;
    t = performance.now();
    await readScopeRollup({ userId: ME, workspaceId: W });
    const msRollup = performance.now() - t;
    expect(holder.prReads).toBe(1);
    console.log(
      `[waiting-on timing] 40 sessions: without holds+PRs ${msBefore.toFixed(0)} ms, with ${msAfter.toFixed(0)} ms; whole space rollup ${msRollup.toFixed(0)} ms`
    );
  });
});

describe("a hold on a dev fact names that fact", () => {
  const since = "2026-10-30T10:00:00.000Z";
  const held = (moves: string, reason: string | null = "CI must pass") =>
    holdWaitingOnRef({
      on: "thing",
      reason,
      until: { moves },
      since,
      resumeTo: "active",
    });

  it("a PR: its name in the hold line's words, and its GitHub page as the door", () => {
    expect(held("pr:synap-core/backend#539")).toEqual({
      kind: "pull_request",
      url: "https://github.com/synap-core/backend/pull/539",
      label: "backend#539",
    });
  });

  it("main and a devbox job: named, never a raw `main:` / `job:` ref or the reason", () => {
    expect(held("main:synap-core/app-bases")).toEqual({
      kind: "thing",
      label: "app-bases main",
    });
    // A person reads "Tests running", never the job's name (D-R4).
    expect(held("job:kit-h", null)).toEqual({
      kind: "thing",
      label: "Tests running",
      waitKind: "devbox_job",
    });
  });
});
