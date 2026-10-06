/**
 * The LENS READ (`signals.list` / `signals.count`) on PGlite — one population
 * seen through pod ⊇ project ⊇ track ⊇ session, and the needs-you duplicate
 * causes, driven through the REAL router with the REAL `proposals.groups`,
 * `notifCenter.list`, owed / draft reads, container resolution and liveness.
 *
 * Stubbed, and why:
 *  - `listSessionsAwaitingReview`: its unit facts come from `attachNextMove`,
 *    which reads a dozen more tables; its scope forwarding is pinned in
 *    `signals.scope.test.ts`, its predicate by `project-needs-you` tests.
 *  - `listActivity` / `listLandedOutputs`: their own PGlite suites pin them;
 *    here they are empty so the page's other classes are what is measured.
 *
 * The fixture (one user, project P with track T):
 *   s1 (P, T)   owed slot · pending proposal X · `session.unblocked`
 *   s2 (P, T)   owed slot · `chat.mention` · a RUNNING IS turn (Happening)
 *   s3 (P)      owed slot · pending proposal X (same shape as s1's)
 *   s4 (—)      owed slot
 *   d1 (P, T)   an undecided agent DRAFT that asks one thing (Proposed)
 *   P-level     a pending proposal filed on P with no session
 *   pod-level   a connector notification (no container) + 2× IS degraded
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

vi.mock("../services/projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async () => ({ sessions: [], truncated: false }),
}));
vi.mock("../services/activity/list-activity.js", () => ({
  listActivity: async () => ({ items: [], nextCursor: null }),
}));
vi.mock("../services/outputs/landed-outputs.js", () => ({
  LANDED_OUTPUTS_MAX_LIMIT: 100,
  listLandedOutputs: async () => ({
    items: [],
    pending: { count: 0, samples: [] },
    nextCursor: null,
    truncated: false,
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  messages,
  channels,
  channelMembers,
  users,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  proposals,
  projects,
  events,
  chatTurns,
  automationRuns,
  automationStepRuns,
  automations,
} from "@synap/database";
import { needsYouRows } from "@synap-core/types/needs-you";
import { signalsRouter } from "./signals.js";
import { sessionsWithOwedSlot } from "../services/signals/lens-containers.js";

const USER = "user-1";
const P = randomUUID();
const T = randomUUID();
const S1 = randomUUID();
const S2 = randomUUID();
const S3 = randomUUID();
const S4 = randomUUID();
const D1 = randomUUID();
const ROOM2 = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${["created_at", "updated_at", "timestamp", "started_at"].includes(c.name) ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const owed = (label: string) => ({
  kind: "document",
  label,
  status: "pending",
  owner: "human",
  owedSince: new Date(Date.now() - 60 * 60_000).toISOString(),
});

async function session(
  id: string,
  opts: {
    projectId?: string;
    trackId?: string;
    origin?: string;
    channelId?: string;
    ago?: number;
  }
) {
  const at = new Date(Date.now() - (opts.ago ?? 30) * 60_000).toISOString();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, project_id, track_id, channel_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, $3, $10, 'active', $4, $5, $6, $7, $8::jsonb, '{}', '{}'::jsonb, '[]'::jsonb, $9, $11, $12)`,
    [
      id,
      USER,
      `Session ${id.slice(0, 4)}`,
      opts.origin ?? "human",
      opts.projectId ?? null,
      opts.trackId ?? null,
      opts.channelId ?? null,
      JSON.stringify([owed(`Deliverable ${id.slice(0, 4)}`)]),
      at,
      `Session ${id.slice(0, 4)}`,
      at,
      at,
    ]
  );
}

async function proposal(opts: { sessionId?: string; projectId?: string }) {
  await q(
    `insert into proposals (id, proposal_type, target_type, target_id, data, status, session_id, project_id, created_by, created_at, updated_at)
     values ($1, 'create', 'entity', null, $2::jsonb, 'pending', $3, $4, $5, now() - interval '20 minutes', now())`,
    [
      randomUUID(),
      JSON.stringify({ name: "Acme" }),
      opts.sessionId ?? null,
      opts.projectId ?? null,
      USER,
    ]
  );
}

async function notify(
  type: string,
  category: string,
  sourceType: string,
  sourceId: string | null,
  title: string,
  minutesAgo = 10
) {
  await q(
    `insert into notifications (id, user_id, type, category, priority, title, body, source_type, source_id, actions, status, created_at)
     values ($1, $2, $3, $4, 'high', $5, '', $6, $7, '[]'::jsonb, 'unread', now() - ($8 || ' minutes')::interval)`,
    [
      randomUUID(),
      USER,
      type,
      category,
      title,
      sourceType,
      sourceId,
      String(minutesAgo),
    ]
  );
}

const caller = () =>
  signalsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);

type Scope = {
  projectId?: string;
  trackId?: string;
  sessionId?: string;
};
const blocking = (scope: Scope) =>
  caller()
    .list({ lens: "needs-you", limit: 100, ...scope })
    .then((r) => r.signals);
const page = (scope: Scope) =>
  caller()
    .list({
      lens: "page",
      caps: {
        blocking: 100,
        proposed: 100,
        happening: 100,
        produced: 100,
        happened: 100,
      },
      ...scope,
    })
    .then((r) => r.page!);

beforeAll(async () => {
  for (const t of [
    focusSessions,
    notifications,
    messages,
    channels,
    channelMembers,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    proposals,
    projects,
    events,
    chatTurns,
    automationRuns,
    automationStepRuns,
    automations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, name, user_type) values ($1, 'Me', 'human')`,
    [USER]
  );
  await session(S1, { projectId: P, trackId: T });
  await session(S2, { projectId: P, trackId: T, channelId: ROOM2, ago: 2 });
  await session(S3, { projectId: P });
  await session(S4, {});
  await session(D1, { projectId: P, trackId: T, origin: "agent" });
  // The SAME shape in s1 and s3 (cross-session), plus a project-level one.
  await proposal({ sessionId: S1, projectId: P });
  await proposal({ sessionId: S3, projectId: P });
  await proposal({ projectId: P });
  // Container-bearing notifications (duplicate cause 1).
  await notify("session.unblocked", "ai", "system", S1, "s1 unblocked");
  await notify("chat.mention", "inbox", "session", S2, "mentioned in s2");
  // A pod-level ask with no container.
  await notify(
    "connector.sync.failed",
    "data",
    "connector",
    null,
    "Gmail sync failed"
  );
  // System health, twice (status banner, never Blocking).
  await notify(
    "pod.storage_warning",
    "system",
    "system",
    null,
    "Storage at 91% capacity",
    5
  );
  await notify(
    "pod.storage_warning",
    "system",
    "system",
    null,
    "Storage at 91% capacity",
    3
  );
  // An OPERATOR notice (P4: registry `informational`) — newest of all, and
  // still in neither the banner nor Blocking.
  await notify(
    "system.intelligence_degraded",
    "system",
    "system",
    null,
    "Operator check: AI service degraded",
    1
  );
  // s2 has an IS turn running right now.
  await q(
    `insert into chat_turns (id, channel_id, status, started_at, updated_at) values ($1, $2, 'running', now(), now())`,
    [randomUUID(), ROOM2]
  );
}, 120_000);

describe("one population, nested scopes — the totals agree", () => {
  it("Blocking: pod ⊇ project ⊇ track ⊇ session, and each total is the sum of its parts", async () => {
    const [pod, project, track, s1, s2, s3, s4] = await Promise.all([
      page({}),
      page({ projectId: P }),
      page({ trackId: T }),
      page({ sessionId: S1 }),
      page({ sessionId: S2 }),
      page({ sessionId: S3 }),
      page({ sessionId: S4 }),
    ]);
    // s1: slot + its proposal part + session.unblocked; s2: slot + mention.
    expect(s1.blocking.total).toBe(3);
    expect(s2.blocking.total).toBe(2);
    expect(s3.blocking.total).toBe(2);
    expect(s4.blocking.total).toBe(1);
    // track = its two sessions.
    expect(track.blocking.total).toBe(s1.blocking.total + s2.blocking.total);
    // project = track + s3 + the project-level proposal (filed on no session).
    expect(project.blocking.total).toBe(
      track.blocking.total + s3.blocking.total + 1
    );
    // pod = project + s4 + the containerless connector notification.
    expect(pod.blocking.total).toBe(
      project.blocking.total + s4.blocking.total + 1
    );
    // Rows ARE the total at every scope (no cap hit) — one derivation.
    for (const p of [pod, project, track, s1, s2, s3, s4]) {
      expect(p.blocking.rows).toHaveLength(p.blocking.total);
      expect(p.blocking.unreadable).toEqual([]);
      expect(p.blocking.truncated).toBe(false);
    }
  });

  it("count equals the page's Blocking total at every scope", async () => {
    for (const scope of [
      {},
      { projectId: P },
      { trackId: T },
      { sessionId: S1 },
    ]) {
      const [c, p] = await Promise.all([caller().count(scope), page(scope)]);
      expect(c.needsYou).toBe(p.blocking.total);
    }
  });

  it("Proposed vs Blocking: the agent draft is Proposed at every scope that holds it, and never Blocking", async () => {
    for (const scope of [
      {},
      { projectId: P },
      { trackId: T },
      { sessionId: D1 },
    ]) {
      const p = await page(scope);
      expect(p.proposed.rows.map((r) => r.kind)).toEqual(["draft-asks"]);
      expect(p.blocking.rows.some((r) => r.target?.id === D1)).toBe(false);
    }
    // ...while a pending proposal under a working session is Blocking.
    const s1 = await page({ sessionId: S1 });
    expect(s1.blocking.rows.map((r) => r.kind)).toContain("proposal-cluster");
    expect(s1.proposed.rows).toEqual([]);
    // Outside the draft's containers it is absent.
    expect((await page({ sessionId: S4 })).proposed.rows).toEqual([]);
  });

  it("Happening: the session with a running turn, at every scope that holds it", async () => {
    for (const scope of [
      {},
      { projectId: P },
      { trackId: T },
      { sessionId: S2 },
    ]) {
      const p = await page(scope);
      expect(p.happening.rows.map((r) => r.target?.id)).toEqual([S2]);
      expect(p.happening.rows[0]!.live?.turnInFlight).toBe(true);
    }
    expect((await page({ sessionId: S1 })).happening.rows).toEqual([]);
  });
});

describe("the needs-you duplicate causes", () => {
  it("cause 1: a notification about a session joins that session's block (one row per session)", async () => {
    const rows = await blocking({ sessionId: S1 });
    expect(new Set(rows.map((r) => r.groupKey))).toEqual(
      new Set([`session:${S1}`])
    );
    const shaped = needsYouRows(rows);
    expect(shaped.recent).toHaveLength(1);
    expect(shaped.recent[0]!.kind).toBe("session");
  });

  it("cross-session clusters: an identical proposal in s1 and s3 sits in EACH session's block, never a loose row", async () => {
    const rows = await blocking({ projectId: P });
    const clusters = rows.filter((r) => r.kind === "proposal-cluster");
    expect(clusters.map((c) => c.groupKey).sort()).toEqual(
      [
        `session:${S1}`,
        `session:${S3}`,
        expect.stringMatching(/^proposal-cluster:/),
      ].sort()
    );
    // Ids stay unique (the parts share a fingerprint).
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const shaped = needsYouRows(rows).recent;
    const sessionsDrawn = shaped.flatMap((r) =>
      r.kind === "session" ? [r.sessionId] : r.session ? [r.session.id] : []
    );
    expect(new Set(sessionsDrawn).size).toBe(sessionsDrawn.length);
  });

  it("cause 3: the pointer fold reads the session's owed state directly, not the capped owed page", async () => {
    expect(await sessionsWithOwedSlot(USER, [S1, S2, randomUUID()])).toEqual(
      new Set([S1, S2])
    );
    // Another user's view of the same sessions: the owner floor holds.
    expect(await sessionsWithOwedSlot("someone-else", [S1])).toEqual(new Set());
  });

  it("system health is ONE banner, folded, and never a Blocking row", async () => {
    const p = await page({});
    expect(p.status).toMatchObject({
      title: "Storage at 91% capacity",
      issues: [{ type: "pod.storage_warning", repeatCount: 2 }],
    });
    expect(p.status?.issues).toHaveLength(1);
    expect(p.statusUnreadable).toBe(false);
    expect(p.blocking.rows.some((r) => r.category === "system")).toBe(false);
    // The banner travels to every scope — health is the pod's, not a container's.
    expect((await page({ sessionId: S4 })).status?.issues).toHaveLength(1);
  });
});

// Dogfood 2026-10-05 (real pod): Home had NO Happening while Claude-code wrote
// into "Content Studio × Brand" seconds earlier. That session is a PLAYBOOK RUN
// (`origin: 'playbook'`, `playbookId`, no track) — `kind: 'run'` — and the
// Happening population was `work` + TRACKED runs only, so the live run never
// reached the D1 rule. The real shape: an agent's MCP writes are `events`
// carrying `session_id`, no IS turn in flight.
describe("Happening: an untracked playbook run an agent is writing into", () => {
  const RUN = randomUUID();
  const RECEIPT = randomUUID();
  beforeAll(async () => {
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    for (const [id, origin, playbookId, metadata] of [
      [RUN, "playbook", randomUUID(), {}],
      // ACCEPTED, so the triage lens alone cannot hide it — only the kind can.
      [
        RECEIPT,
        "agent",
        null,
        {
          kind: "agent-proposal-package",
          triage: { acceptedAt: new Date().toISOString() },
        },
      ],
    ] as const) {
      await q(
        `insert into focus_sessions (id, user_id, goal, title, status, origin, playbook_id, project_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
         values ($1, $2, 'g', $3, 'active', $4, $5, $6, '[]'::jsonb, '{}', $7::jsonb, '[]'::jsonb, $8, $8, $8)`,
        [
          id,
          USER,
          `Live ${id.slice(0, 4)}`,
          origin,
          playbookId,
          P,
          JSON.stringify(metadata),
          at,
        ]
      );
      await q(
        `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, session_id)
         values ($1, now() - interval '1 minute', 'entities.update.completed', $2, 'entity', '{}'::jsonb, $3, $4)`,
        [randomUUID(), randomUUID(), USER, id]
      );
    }
  });

  it("is Happening at pod and project scope; an agent-write RECEIPT is not work", async () => {
    for (const scope of [{}, { projectId: P }]) {
      const ids = (await page(scope)).happening.rows.map((r) => r.target?.id);
      expect(ids).toContain(RUN);
      expect(ids).not.toContain(RECEIPT);
    }
    expect((await page({ sessionId: RUN })).happening.rows).toHaveLength(1);
  });
});

describe("Happening: a rule running without a session (C5)", () => {
  const BUSY = randomUUID();
  const BROKE = randomUUID();
  const WITH_SESSION = randomUUID();
  const SKIPPER = randomUUID();
  const run = async (
    automationId: string,
    status: string,
    opts: { minutesAgo?: number } = {}
  ) => {
    const id = randomUUID();
    await q(
      `insert into automation_runs (id, automation_id, workspace_id, status, trigger_payload, steps_completed, steps_failed, started_at)
       values ($1, $2, null, $3, '{}'::jsonb, 0, 0, now() - ($4 || ' minutes')::interval)`,
      [id, automationId, status, String(opts.minutesAgo ?? 1)]
    );
    return id;
  };
  beforeAll(async () => {
    for (const [id, name] of [
      [BUSY, "Gmail triage"],
      [BROKE, "Enrich contact"],
      [WITH_SESSION, "Qualify lead"],
      [SKIPPER, "Deduped rule"],
    ] as const) {
      await q(
        `insert into automations (id, name, workspace_id, status, trigger_type, created_by)
         values ($1, $2, null, 'active', 'event', $3)`,
        [id, name, USER]
      );
    }
    for (let i = 0; i < 5; i += 1) await run(BUSY, "completed");
    await run(BUSY, "completed", { minutesAgo: 90 }); // outside the window
    await run(BROKE, "completed");
    await run(BROKE, "failed");
    // A run that opened a session IS its live-session row — not a rule row.
    const opened = await run(WITH_SESSION, "completed");
    await q(
      `insert into focus_sessions (id, user_id, goal, title, status, origin, expected_outputs, agent_ids, metadata, criteria)
       values ($1, $2, 'g', 'Run', 'completed', 'automation', '[]'::jsonb, '{}', $3::jsonb, '[]'::jsonb)`,
      [randomUUID(), USER, JSON.stringify({ automationRunId: opened })]
    );
    await run(SKIPPER, "skipped");
  });

  it("is ONE row per rule, its runs folded, a failure marked — at pod scope", async () => {
    const rows = (await page({})).happening.rows.filter(
      (r) => r.kind === "rule-run"
    );
    const byId = new Map(rows.map((r) => [r.target?.id, r]));
    expect([...byId.keys()].sort()).toEqual([BUSY, BROKE].sort());
    expect(byId.get(BUSY)).toMatchObject({
      title: "Gmail triage",
      repeatCount: 5,
      ruleRun: { runs: 5, failed: 0 },
      target: { kind: "automation", id: BUSY },
    });
    expect(byId.get(BROKE)?.ruleRun).toMatchObject({ runs: 2, failed: 1 });
  });

  it("is not guessed into a project or session (a run carries neither)", async () => {
    for (const scope of [{ projectId: P }, { sessionId: S2 }]) {
      const rows = (await page(scope)).happening.rows;
      expect(rows.some((r) => r.kind === "rule-run")).toBe(false);
    }
  });
});
