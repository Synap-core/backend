/**
 * The needs-you read's OPEN-PR fact, through the REAL router on PGlite:
 *
 *  (A) ONE read per needs-you call. The owed half (`listOwedSlots`), the
 *      decisions half (`classifyPendingProposals`, inside `proposals.groups`)
 *      and the clusters' order (`readAttention`) each read it; measured on the
 *      founder's pod (2026-11-26) that was three `events` scans per badge.
 *      They share ONE read (`sharedOpenPrRead`), and the fact still reaches
 *      every consumer (the owed row and the cluster row both carry it).
 *  (B) A failed read is a FAILURE, never "no open PR": the badge and the
 *      needs-you list throw, the page names the halves it could not read.
 *
 * The PR-state read (`readOpenWorkUnits`) is the counted seam: its own suites
 * pin its SQL. Stubbed halves are pinned by their own suites, as in
 * `signals.lens-read-cost.pglite.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  /** One entry per PR-state read: the sessions it was asked about. */
  reads: [] as string[][],
  fail: false,
  open: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

vi.mock("../services/status/status-facts.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readOpenWorkUnits: async (_reader: unknown, sessionIds: string[]) => {
    h.reads.push([...sessionIds]);
    if (h.fail) throw new Error("PR state read timed out");
    return new Map(
      sessionIds
        .filter((id) => h.open.has(id))
        .map((id) => [
          id,
          [
            {
              url: "https://github.com/acme/app/pull/7",
              label: "acme/app#7",
              facts: { state: "open" },
            },
          ],
        ])
    );
  },
}));

vi.mock("../services/signals/access-requests.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listPendingIssuers: async () => ({ rows: [], truncated: false }),
  listPendingAppRequests: async () => ({ rows: [], truncated: false }),
  listPendingKeyRequests: async () => ({ rows: [], truncated: false }),
}));
vi.mock("../services/signals/permission-sessions.js", () => ({
  listSessionsWaitingForPermission: async () => ({
    sessions: [],
    truncated: false,
  }),
}));
vi.mock("../services/signals/broken-connections.js", () => ({
  listBrokenConnections: async () => ({ rows: [], truncated: false }),
}));
vi.mock("../services/signals/landed-needs.js", () => ({
  listLandedNeedsPerson: async () => ({ rows: [], truncated: false }),
}));
vi.mock("../services/signals/space-invites.js", () => ({
  listOpenSpaceInvites: async () => ({ rows: [], truncated: false }),
}));
vi.mock("../services/signals/convertible-goals.js", () => ({
  listConvertibleGoals: async () => ({
    rows: [],
    truncated: false,
    newestAt: null,
  }),
}));
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
  apiKeys,
  podMembers,
  projectMembers,
  proposals,
  proposalSnoozes,
  projects,
  events,
  chatTurns,
  automationRuns,
  automationStepRuns,
  playbookRuns,
} from "@synap/database";
import { signalsRouter } from "./signals.js";

const USER = "user-1";
const PROJECT = randomUUID();
const S = randomUUID(); // owes the person a slot AND files a plan gate

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

const caller = () =>
  signalsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);

/** The reads that asked about some session (an empty ask reads nothing). */
const realReads = () => h.reads.filter((ids) => ids.length > 0);

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
    apiKeys,
    podMembers,
    projectMembers,
    proposals,
    proposalSnoozes,
    projects,
    events,
    chatTurns,
    automationRuns,
    automationStepRuns,
    playbookRuns,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, name, user_type) values ($1, 'Me', 'human')`,
    [USER]
  );
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, project_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, 'Ship the fix', 'Ship the fix', 'active', 'human', $3, $4::jsonb, '{}', '{}'::jsonb, '[]'::jsonb, $5, $5, $5)`,
    [
      S,
      USER,
      PROJECT,
      JSON.stringify([
        {
          kind: "decision",
          label: "Which rollout",
          status: "pending",
          owner: "human",
          owedSince: at,
        },
      ]),
      at,
    ]
  );
  // A plan GATE: something waits on it, so it stays in the headline.
  await q(
    `insert into proposals (id, proposal_type, target_type, target_id, data, status, session_id, project_id, created_by, created_at, updated_at)
     values ($1, 'dev.plan_approval', 'entity', null, $2::jsonb, 'pending', $3, $4, $5, now() - interval '1 minute', now())`,
    [randomUUID(), JSON.stringify({ name: "Plan" }), S, PROJECT, USER]
  );
});

beforeEach(() => {
  h.reads = [];
  h.fail = false;
  h.open = new Set([S]);
});

describe("(A) the open-PR fact is read ONCE per needs-you read", () => {
  it("signals.count: one PR-state read for the owed half, the decisions half and the clusters' order", async () => {
    await caller().count({});
    expect(realReads()).toEqual([[S]]);
  });

  it("signals.list needs-you: one read, and the fact reaches the owed row AND the cluster row", async () => {
    const { signals } = await caller().list({ lens: "needs-you" });
    expect(realReads()).toEqual([[S]]);
    const owed = signals.find((s) => s.kind === "owed-slot");
    const cluster = signals.find((s) => s.kind === "proposal-cluster");
    expect(owed?.blocksOpenPr).toBe(true);
    expect(cluster?.blocksOpenPr).toBe(true);
  });

  it("no open PR: still one read, and no row claims one", async () => {
    h.open = new Set();
    const { signals } = await caller().list({ lens: "needs-you" });
    expect(realReads()).toEqual([[S]]);
    expect(signals.some((s) => s.blocksOpenPr)).toBe(false);
  });
});

describe("(B) a failed open-PR read is a failure, never 'no open PR'", () => {
  it("signals.count throws instead of a number that treats every PR as closed", async () => {
    h.fail = true;
    await expect(caller().count({})).rejects.toThrow(/PR state read/);
  });

  it("signals.list needs-you throws instead of an unblocked list", async () => {
    h.fail = true;
    await expect(caller().list({ lens: "needs-you" })).rejects.toThrow(
      /PR state read/
    );
  });

  it("the page names the halves it could not read", async () => {
    h.fail = true;
    const { page } = await caller().list({ lens: "page" });
    expect(page!.blocking.unreadable).toEqual(
      expect.arrayContaining(["owed", "proposals"])
    );
  });
});
