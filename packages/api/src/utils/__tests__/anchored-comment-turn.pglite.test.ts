/**
 * planAnchoredCommentTurn on a real Postgres (PGlite): the trigger decision and
 * the resolved anchor are read back from rows, nothing hand-built downstream.
 *
 * Discriminating inputs (each rules a wrong rule out):
 *  - a session with `metadata.intake` and NO pending proposal → triggers
 *    (rules out "only a pending proposal wakes the agent");
 *  - a plain work session + PENDING proposal → triggers, + APPROVED → does not
 *    (rules out "any anchored proposal in a session channel wakes the agent");
 *  - a channel with no session → does not (rules out "any anchor triggers");
 *  - revision_history length 2 vs contentVersion 1 → stale (rules out a stale
 *    flag that is always false).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
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

import { planAnchoredCommentTurn } from "../anchored-comment-turn.js";

const DDL = `
  create table focus_sessions (
    id uuid primary key, channel_id uuid, metadata jsonb not null default '{}'::jsonb
  );
  create table proposals (
    id uuid primary key, status text not null, data jsonb not null,
    session_id uuid, agent_user_id text,
    revision_history jsonb not null default '[]'::jsonb
  );
  create table users (id text primary key, agent_type text);
`;

const graph = {
  operations: [
    { op: "create_entity", profileSlug: "bookmark", title: "Mixer screen" },
    {
      op: "create_entity",
      ref: "t2",
      profileSlug: "transition",
      title: "Crossfade at 1:04",
      properties: { position: "1:04", deck: "A" },
    },
  ],
};

async function session(metadata: Record<string, unknown>, channelId: string) {
  const id = randomUUID();
  await h.client!.query(
    "insert into focus_sessions (id, channel_id, metadata) values ($1, $2, $3::jsonb)",
    [id, channelId, JSON.stringify(metadata)]
  );
  return id;
}

async function proposal(input: {
  sessionId: string | null;
  status?: string;
  revisions?: number;
  agentUserId?: string | null;
}) {
  const id = randomUUID();
  await h.client!.query(
    `insert into proposals (id, status, data, session_id, agent_user_id, revision_history)
     values ($1, $2, $3::jsonb, $4, $5, $6::jsonb)`,
    [
      id,
      input.status ?? "pending",
      JSON.stringify(graph),
      input.sessionId,
      input.agentUserId ?? null,
      JSON.stringify(Array.from({ length: input.revisions ?? 0 }, () => ({}))),
    ]
  );
  return id;
}

beforeAll(async () => {
  await h.client!.exec(DDL);
  await h.client!.query(
    "insert into users (id, agent_type) values ('agent-capture', 'capture-analyst')"
  );
});

describe("planAnchoredCommentTurn", () => {
  it("an anchored comment on an intake run triggers, with the op resolved and the proposal's agent", async () => {
    const channelId = randomUUID();
    const sessionId = await session({ intake: { door: "capture" } }, channelId);
    const proposalId = await proposal({
      sessionId,
      agentUserId: "agent-capture",
    });

    const plan = await planAnchoredCommentTurn({
      anchor: { proposalId, opRef: "t2", field: "position", contentVersion: 0 },
      channelId,
      comment: "this mixer position means a transition",
    });

    expect(plan.decision).toEqual({
      trigger: true,
      reason: "intake_run",
      agentType: "capture-analyst",
    });
    expect(plan.context).toMatchObject({
      version: 1,
      resolution: "resolved",
      proposalId,
      proposalStatus: "pending",
      opRef: "t2",
      op: {
        index: 1,
        kind: "create_entity",
        title: "Crossfade at 1:04",
        profileSlug: "transition",
        // jsonb does not keep insertion order — compare as a set.
        fieldKeys: expect.arrayContaining(["position", "deck"]),
      },
      field: "position",
      contentVersion: 0,
      currentVersion: 0,
      stale: false,
      comment: "this mixer position means a transition",
    });
  });

  it("a run session with NO proposal anchor still triggers, on the default agent", async () => {
    const channelId = randomUUID();
    await session({ run: { engine: "structure" } }, channelId);

    const plan = await planAnchoredCommentTurn({
      anchor: { contentVersion: 0 },
      channelId,
      comment: "these screenshots are bookmarks",
    });

    expect(plan.decision).toEqual({ trigger: true, reason: "intake_run" });
    expect(plan.context.resolution).toBe("no_proposal");
  });

  it("a stale contentVersion is flagged against revision_history length", async () => {
    const channelId = randomUUID();
    const sessionId = await session({ intake: {} }, channelId);
    const proposalId = await proposal({ sessionId, revisions: 2 });

    const plan = await planAnchoredCommentTurn({
      anchor: { proposalId, opRef: "$op0", contentVersion: 1 },
      channelId,
      comment: "rename it",
    });

    expect(plan.context).toMatchObject({
      stale: true,
      contentVersion: 1,
      currentVersion: 2,
      op: { index: 0, title: "Mixer screen" },
    });
  });

  it("a work session triggers on a PENDING anchored proposal and not on an APPROVED one", async () => {
    const channelId = randomUUID();
    const sessionId = await session({ source: "manual" }, channelId);
    const pending = await proposal({ sessionId });
    const approved = await proposal({ sessionId, status: "approved" });

    const onPending = await planAnchoredCommentTurn({
      anchor: { proposalId: pending, contentVersion: 0 },
      channelId,
      comment: "x",
    });
    const onApproved = await planAnchoredCommentTurn({
      anchor: { proposalId: approved, contentVersion: 0 },
      channelId,
      comment: "x",
    });

    expect(onPending.decision).toEqual({
      trigger: true,
      reason: "pending_proposal",
    });
    expect(onApproved.decision).toEqual({
      trigger: false,
      reason: "not_run_or_pending",
    });
  });

  it("a channel with no session never triggers, and an unknown opRef is reported, not guessed", async () => {
    const proposalId = await proposal({ sessionId: null });

    const plan = await planAnchoredCommentTurn({
      anchor: { proposalId, opRef: "ghost", contentVersion: 0 },
      channelId: randomUUID(),
      comment: "x",
    });

    expect(plan.decision).toEqual({
      trigger: false,
      reason: "not_session_channel",
    });
    expect(plan.context).toMatchObject({
      resolution: "op_not_found",
      op: null,
    });
  });
});
