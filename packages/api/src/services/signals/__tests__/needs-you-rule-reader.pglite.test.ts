/**
 * THE needs-you rule, end to end through the READER on PGlite (decision E):
 * `listNeedsYouOwed` measures each session's agent evidence in the same query
 * (the SQL twin's fragments), stamps every owed slot with its class, and
 * `countNeedsYou` folds them — the census shape of 2026-10-26 in miniature.
 *
 * One session per fold, each with the fact that puts it there, and its twin
 * one fact away where that matters:
 *   - live      — an agent posted an hour ago → the headline;
 *   - human     — only the PERSON posted lately (and `updated_at` is now) →
 *                 Stopped: neither is agent evidence;
 *   - turn      — an agent turn in flight → Working;
 *   - quiet     — the agent's last evidence (an event) is 9 days old → Stopped;
 *   - machine   — a decision ask no agent filed, on live work → From the
 *                 system;
 *   - grade     — the evaluating agent's criterion escalation on live work →
 *                 the headline (M3: a criterion grade stands for its asker);
 *   - old       — a real ask owed 9 days on live work → Review later;
 *   - deploy    — a gate owed 9 days on live work → the headline (a
 *                 commitment never ages).
 *
 * Negative control: the reader without its classification (the pre-rule
 * `listOwedSlots`) puts all eight in the headline.
 *
 * U1: the session rows' `unitFacts` (`attachPathSections`, what every card,
 * pill and the work graph read) count the SAME headline: per session, and in
 * sum equal to `countNeedsYou().folds.needsYou` over the same pod, proposals
 * included (a gate needs you; a change to review and a wait on a session an
 * agent is working do not, F2).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
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

// The asker's display name is a users read this test does not set up.
vi.mock("../../tracks/track-participant-store.js", () => ({
  participantDisplayNames: async () => new Map<string, string>(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  chatTurns,
  events,
  focusSessions,
  messages,
  playbookRuns,
  proposals,
} from "@synap/database";
import { listNeedsYouOwed } from "../needs-you-owed.js";
import { countNeedsYou } from "../needs-you-union.js";
import { attachPathSections } from "../../focus-sessions/session-path-sections.js";
import { classifyPendingProposals } from "../../proposals/proposal-needs-you.js";
import { resolveScope } from "../../../utils/scope-filter.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "agent-user-1";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const ask = (over: Record<string, unknown> = {}) => ({
  kind: "decision",
  label: `Ask ${randomUUID().slice(0, 8)}`,
  owner: "human",
  blockedReason: "decision",
  owedSince: ago(DAY),
  askedBy: AGENT,
  ask: { mode: "confirm" },
  ...over,
});

async function session(p: {
  slots: Array<Record<string, unknown>>;
  agentPostAt?: string;
  humanPostAt?: string;
  turnRunning?: boolean;
  agentEventAt?: string;
}): Promise<string> {
  const id = randomUUID();
  const channel = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, channel_id, started_at, created_at, updated_at)
     values ($1, $2, 'Work', 'active', $3::jsonb, '{}'::jsonb, $4, $5, $5, $6)`,
    [
      id,
      OWNER,
      JSON.stringify(p.slots),
      channel,
      ago(20 * DAY),
      NOW.toISOString(),
    ]
  );
  if (p.agentPostAt)
    await q(
      `insert into messages (id, channel_id, author_type, timestamp) values ($1, $2, 'ai_agent', $3)`,
      [randomUUID(), channel, p.agentPostAt]
    );
  if (p.humanPostAt)
    await q(
      `insert into messages (id, channel_id, author_type, timestamp) values ($1, $2, 'user', $3)`,
      [randomUUID(), channel, p.humanPostAt]
    );
  if (p.turnRunning)
    await q(
      `insert into chat_turns (id, channel_id, status, updated_at) values ($1, $2, 'running', $3)`,
      [randomUUID(), channel, ago(2 * DAY)]
    );
  if (p.agentEventAt)
    await q(
      `insert into events (id, session_id, agent_user_id, timestamp) values ($1, $2, $3, $4)`,
      [randomUUID(), id, AGENT, p.agentEventAt]
    );
  return id;
}

describe("listNeedsYouOwed + countNeedsYou: THE rule through the reader", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    for (const t of [
      focusSessions,
      messages,
      chatTurns,
      proposals,
      events,
      playbookRuns,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    const hour = 3_600_000;
    ids.live = await session({ slots: [ask()], agentPostAt: ago(hour) });
    ids.human = await session({ slots: [ask()], humanPostAt: ago(hour) });
    ids.turn = await session({
      slots: [ask({ label: "Turn ask" })],
      agentPostAt: ago(2 * DAY),
      turnRunning: true,
    });
    ids.quiet = await session({ slots: [ask()], agentEventAt: ago(9 * DAY) });
    ids.machine = await session({
      slots: [ask({ askedBy: undefined, askCause: { kind: "decision" } })],
      agentPostAt: ago(hour),
    });
    ids.grade = await session({
      slots: [
        {
          kind: "criterion",
          label: "Check: 8 comparables",
          owner: "human",
          criterionKey: "k",
          blockedReason: "decision",
          owedSince: ago(DAY),
        },
      ],
      agentPostAt: ago(hour),
    });
    ids.old = await session({
      slots: [ask({ owedSince: ago(9 * DAY) })],
      agentPostAt: ago(hour),
    });
    ids.deploy = await session({
      slots: [
        ask({
          owedSince: ago(9 * DAY),
          askedBy: undefined,
          askCause: { kind: "gate" },
        }),
      ],
      agentPostAt: ago(hour),
    });
  }, 120_000);
  afterAll(async () => h.client?.close());

  it("stamps every owed slot with the rule's class", async () => {
    const slots = await listNeedsYouOwed({
      userId: OWNER,
      scope: resolveScope({}, { workspaceId: [] }),
      limit: 100,
      now: NOW,
    });
    const bySession = Object.fromEntries(
      slots.map((s) => [
        Object.entries(ids).find(([, id]) => id === s.sessionId)![0],
        s.needsYouClass,
      ])
    );
    expect(bySession).toEqual({
      live: "needs_you",
      human: "stopped",
      turn: "working",
      quiet: "stopped",
      machine: "from_system",
      grade: "needs_you",
      old: "review_later",
      deploy: "needs_you",
    });

    const count = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      notifications: [],
      clusters: [],
      notificationsTruncated: false,
      owedSlots: slots,
      owedTruncated: false,
      now: NOW,
    });
    expect(count.blocked).toBe(3);
    expect(count.folds).toEqual({
      needsYou: 3,
      working: 1,
      stopped: 2,
      stoppedSessions: 2,
      reviewLater: 1,
      fromSystem: 1,
      changesToReview: 0,
    });
    // Nothing dropped: the headline plus every fold is every owed slot.
    expect(count.blocked + count.reviewLater).toBe(slots.length);
  });

  it("U1: the rows' unitFacts count the SAME headline, proposals included", async () => {
    const pending = (id: string, proposalType: string, data: unknown) =>
      q(
        `insert into proposals (id, session_id, proposal_type, target_type, status, data, created_at)
         values ($1, $2, $3, 'entity', 'pending', $4::jsonb, $5)`,
        [randomUUID(), id, proposalType, JSON.stringify(data), ago(DAY)]
      );
    // A gate: needs you. Bookkeeping: a change to review. A wait on the
    // session an agent is working (its owed "Turn ask"): Working (F2).
    await pending(ids.live!, "dev.deploy_approval", {});
    await pending(ids.live!, "entity.update", {});
    await pending(ids.turn!, "entity.update", { expectedLabel: "Turn ask" });

    const rows = (
      await h.client!.query<Record<string, unknown>>(
        `select id, goal, status, workspace_id as "workspaceId", project_id as "projectId",
              expected_outputs as "expectedOutputs", origin, metadata
         from focus_sessions where id = any($1::uuid[])`,
        [Object.values(ids)]
      )
    ).rows as unknown as Parameters<typeof attachPathSections>[0];
    const sectioned = await attachPathSections(rows, {
      userId: OWNER,
      now: NOW,
    });
    const facts = Object.fromEntries(
      sectioned.map((r) => [
        Object.entries(ids).find(([, id]) => id === r.id)![0],
        [r.unitFacts.owedFromYou, r.unitFacts.pendingDecisions],
      ])
    );
    expect(facts).toEqual({
      live: [1, 1],
      human: [0, 0],
      turn: [0, 0],
      quiet: [0, 0],
      machine: [0, 0],
      grade: [1, 0],
      old: [0, 0],
      deploy: [1, 0],
    });

    // One number, one source: the same pod through the signals count.
    const slots = await listNeedsYouOwed({
      userId: OWNER,
      scope: resolveScope({}, { workspaceId: [] }),
      limit: 100,
      now: NOW,
    });
    const proposalRows = (
      await h.client!.query<Record<string, unknown>>(
        `select id, proposal_type as "proposalType", status, session_id as "sessionId", data, created_at as "createdAt"
         from proposals where status = 'pending'`
      )
    ).rows as unknown as Parameters<typeof classifyPendingProposals>[0];
    const classes = await classifyPendingProposals(
      proposalRows,
      { userId: OWNER },
      NOW
    );
    expect([...classes.values()].sort()).toEqual(
      ["changes_to_review", "needs_you", "working"].sort()
    );
    const headlineClusters = [...classes.values()].filter(
      (c) => c === "needs_you"
    ).length;
    const count = countNeedsYou({
      distinctClusters: classes.size,
      reviewLaterClusters: classes.size - headlineClusters,
      clustersTruncated: false,
      notifications: [],
      clusters: [],
      notificationsTruncated: false,
      owedSlots: slots,
      owedTruncated: false,
      now: NOW,
    });
    const sum = sectioned.reduce(
      (n, r) =>
        n +
        (r.unitFacts.owedFromYou ?? 0) +
        (r.unitFacts.pendingDecisions ?? 0),
      0
    );
    expect(sum).toBe(count.folds.needsYou);
    expect(sum).toBe(4);
  });
});
