/**
 * A session that ends stops asking (Resolve-XP W2) — the REAL
 * `completeFocusSession` on PGlite, with the room's messages in the database.
 *
 * Each test names what it rules out:
 *   - a person's close leaving the room's open question open (it would stay
 *     in needs-you and a later reply would still read as its answer);
 *   - the end retiring a person's deliverable (`act`) or keeping the agent's
 *     own ask (`confirm`, an ask-less `decision`) owed;
 *   - an agent closing over its own open question without a word on it, or
 *     being refused over ANOTHER agent's question, or on a cancel;
 *   - a disposition that does not land: a withdrawal without its note, a
 *     kept question whose slot retires anyway;
 *   - the bell keeping a "needs you" row for a session with nothing left.
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose`: granted — the
 * membrane is not under test), the close event's two halves, ephemeral
 * expiry, `notifySessionNeedsYou` (the push producer; `settleSessionNeedsYou`
 * beside it stays REAL), block guidance, and `updateFocusSession` (the
 * governed `addOutput` door: the stub appends the slot it was asked for, so
 * the retirement that follows reads a real row).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  addOutputs: [] as Array<Record<string, unknown>>,
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
      schema: {
        focusSessions: actual.focusSessions as never,
        sessionEvaluations: actual.sessionEvaluations as never,
        notifications: actual.notifications as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("@synap/jobs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, settleParentAutomationRunFromChild: async () => undefined };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, checkPermissionOrPropose: async () => ({ granted: true }) };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));
vi.mock("../provide-secret-grant.js", () => ({
  revokeSessionProvidedGrants: async () => undefined,
}));
vi.mock("../block-guidelines.js", () => ({
  guidanceForBlockedSlots: async () => null,
}));
vi.mock("../notify-needs-you.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notifySessionNeedsYou: async () => false };
});
vi.mock("../update-session.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    updateFocusSession: async (p: {
      sessionId: string;
      addOutput?: Record<string, unknown>;
    }) => {
      h.addOutputs.push(p.addOutput ?? {});
      await h.client!.query(
        `update focus_sessions set expected_outputs = expected_outputs || $2::jsonb where id = $1`,
        [p.sessionId, JSON.stringify([{ ...p.addOutput, status: "pending" }])]
      );
      return { status: "updated", session: {} };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  messages,
  playbookRuns,
  playbooks,
  proposals,
  notifications,
  sessionEvaluations,
} from "@synap/database";
import {
  completeFocusSession,
  isOpenQuestionsAtCloseError,
} from "../complete-session.js";
import { recordOwnerRoomReply } from "../session-answer.js";

const USER = "user-1";
const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const dflt =
      c.name === "created_at" || c.name === "timestamp" ? " default now()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [
    focusSessions,
    messages,
    playbookRuns,
    playbooks,
    proposals,
    notifications,
    sessionEvaluations,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

async function session(slots: unknown[] = []) {
  const id = randomUUID();
  const channel = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, channel_id, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', 'Ship', 'active', $3, $4::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, USER, channel, JSON.stringify(slots)]
  );
  return { id, channel };
}

async function question(
  channel: string,
  p: { by?: string; text?: string; slotLabel?: string; answered?: boolean } = {}
) {
  const id = randomUUID();
  const roomPost: Record<string, unknown> = { kind: "question" };
  if (p.slotLabel) roomPost.slotLabel = p.slotLabel;
  if (p.answered) roomPost.answer = { text: "yes", answeredBy: USER };
  await q(
    `insert into messages (id, channel_id, role, author_type, content, user_id, hash, routed_teammate_id, metadata)
     values ($1, $2, 'assistant', 'ai_agent', $3, $4, 'h', $5, $6::jsonb)`,
    [id, channel, p.text ?? "Which account?", USER, p.by ?? AGENT, JSON.stringify({ roomPost })]
  );
  return id;
}

async function roomPost(id: string): Promise<Record<string, unknown>> {
  const r = await q<{ metadata: { roomPost: Record<string, unknown> } }>(
    `select metadata from messages where id = $1`,
    [id]
  );
  return r.rows[0]!.metadata.roomPost;
}

async function slotsOf(id: string): Promise<Array<Record<string, unknown>>> {
  const r = await q<{ expected_outputs: Array<Record<string, unknown>> }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  );
  return r.rows[0]!.expected_outputs;
}

async function statusOf(id: string) {
  const r = await q<{ status: string }>(
    `select status from focus_sessions where id = $1`,
    [id]
  );
  return r.rows[0]!.status;
}

const CONFIRM = {
  kind: "decision",
  label: "Ship it?",
  owner: "human",
  blockedReason: "decision",
  ask: { mode: "confirm" },
  owedSince: "2026-10-01T00:00:00.000Z",
};
const BARE_DECISION = {
  kind: "decision",
  label: "EU or US?",
  owner: "human",
  blockedReason: "decision",
  owedSince: "2026-10-01T00:00:00.000Z",
};
const ACT = {
  kind: "doc",
  label: "Sign the DPA",
  owner: "human",
  blockedReason: "physical",
  ask: { mode: "act" },
  owedSince: "2026-10-01T00:00:00.000Z",
};

describe("a person's close stamps what the session leaves open", () => {
  it("closes open questions, retires the agent's asks, keeps the person's deliverable", async () => {
    const s = await session([CONFIRM, BARE_DECISION, ACT]);
    const open = await question(s.channel);
    const answered = await question(s.channel, { answered: true });

    const res = await completeFocusSession({ sessionId: s.id, userId: USER });

    expect(res!.counts.closedQuestions).toBe(1);
    expect((await roomPost(open)).closed).toMatchObject({
      reason: "session_ended",
    });
    // An answer is the fact: it is never closed over.
    expect((await roomPost(answered)).closed).toBeUndefined();

    const byLabel = new Map((await slotsOf(s.id)).map((o) => [o.label, o]));
    expect(byLabel.get(CONFIRM.label)!.retiredReason).toBe("session_ended");
    expect(byLabel.get(BARE_DECISION.label)!.retiredReason).toBe(
      "session_ended"
    );
    expect(byLabel.get(ACT.label)!.retiredAt).toBeUndefined();
    expect(res!.counts.retiredSlots).toBe(2);
    expect(res!.warnings.join("\n")).toMatch(/closed because the session ended/);
    expect(res!.warnings.join("\n")).toMatch(/retired because the session ended/);
  });

  it("an owner reply in the ended room no longer answers the closed question", async () => {
    const s = await session();
    const open = await question(s.channel);
    await completeFocusSession({ sessionId: s.id, userId: USER });

    const reply = await recordOwnerRoomReply({
      channelId: s.channel,
      messageId: randomUUID(),
      content: "EU",
      userId: USER,
      wake: false,
    });
    expect(reply).toEqual({ status: "no_open_question" });
    expect((await roomPost(open)).answer).toBeUndefined();
  });

  it("settles the session's needs-you rows once nothing is left — and only then", async () => {
    const note = async (sessionId: string) => {
      const id = randomUUID();
      await q(
        `insert into notifications (id, user_id, type, source_type, source_id, status)
         values ($1, $2, 'session.needs_you', 'session', $3, 'unread')`,
        [id, USER, sessionId]
      );
      return id;
    };
    const statusOfNote = async (id: string) =>
      (
        await q<{ status: string }>(
          `select status from notifications where id = $1`,
          [id]
        )
      ).rows[0]!.status;

    const done = await session();
    await question(done.channel);
    const doneNote = await note(done.id);
    await completeFocusSession({ sessionId: done.id, userId: USER });
    expect(await statusOfNote(doneNote)).toBe("actioned");

    // The person still owes the act: the row stays.
    const owing = await session([ACT]);
    await question(owing.channel);
    const owingNote = await note(owing.id);
    await completeFocusSession({ sessionId: owing.id, userId: USER });
    expect(await statusOfNote(owingNote)).toBe("unread");
  });
});

describe("an agent's close and its own open questions", () => {
  it("is refused with the list while its question is open — nothing closes", async () => {
    const s = await session();
    const mine = await question(s.channel, { text: "Deploy to prod?" });
    const theirs = await question(s.channel, { by: OTHER_AGENT });

    const err = await completeFocusSession({
      sessionId: s.id,
      userId: USER,
      agentUserId: AGENT,
    }).catch((e: unknown) => e);

    expect(isOpenQuestionsAtCloseError(err)).toBe(true);
    const listed = (err as { openQuestions: Array<Record<string, unknown>> })
      .openQuestions;
    // Its own question only — another agent's is not its to settle.
    expect(listed).toEqual([
      {
        messageId: mine,
        shortId: `Q-${mine.slice(0, 8)}`,
        text: "Deploy to prod?",
        slotLabel: null,
      },
    ]);
    expect((err as Error).message).toContain(`Q-${mine.slice(0, 8)}`);
    expect((err as Error).message).toContain("synap_relay_answer");
    expect(await statusOf(s.id)).toBe("active");
    expect((await roomPost(mine)).closed).toBeUndefined();
    expect((await roomPost(theirs)).closed).toBeUndefined();
  });

  it("a cancel is never refused, and stamps the questions", async () => {
    const s = await session();
    const mine = await question(s.channel);
    await completeFocusSession({
      sessionId: s.id,
      userId: USER,
      agentUserId: AGENT,
      terminalStatus: "cancelled",
    });
    expect(await statusOf(s.id)).toBe("cancelled");
    expect((await roomPost(mine)).closed).toMatchObject({
      reason: "session_ended",
    });
  });

  it("passes with a word on each: withdrawn keeps its note, kept ones stay owed", async () => {
    const s = await session([CONFIRM]);
    const withdrawn = await question(s.channel);
    const keptOnSlot = await question(s.channel, { slotLabel: CONFIRM.label });
    const keptSlotless = await question(s.channel, {
      text: "Which region should the bucket live in?",
    });
    const theirs = await question(s.channel, { by: OTHER_AGENT });

    const res = await completeFocusSession({
      sessionId: s.id,
      userId: USER,
      agentUserId: AGENT,
      questionDispositions: [
        { messageId: withdrawn, disposition: "withdrawn", note: "found it in the brief" },
        { messageId: keptOnSlot, disposition: "keep_as_owed" },
        { messageId: keptSlotless, disposition: "keep_as_owed" },
        { messageId: theirs, disposition: "withdrawn" },
      ],
    });

    expect(await statusOf(s.id)).toBe("closed");
    expect((await roomPost(withdrawn)).closed).toMatchObject({
      reason: "withdrawn",
      by: AGENT,
      note: "found it in the brief",
    });
    // Kept questions close with the session: their slot carries them on.
    expect((await roomPost(keptOnSlot)).closed).toMatchObject({
      reason: "session_ended",
    });
    // Another agent's question is not this agent's to withdraw.
    expect((await roomPost(theirs)).closed).toMatchObject({
      reason: "session_ended",
    });
    expect(res!.warnings.join("\n")).toMatch(/named no open question of yours/);

    const byLabel = new Map((await slotsOf(s.id)).map((o) => [o.label, o]));
    // The confirm it kept is NOT retired, though a confirm otherwise would be.
    expect(byLabel.get(CONFIRM.label)!.retiredAt).toBeUndefined();
    expect(byLabel.get(CONFIRM.label)!.owner).toBe("human");
    // The slotless one became a slot of the person's, through addOutput, kept.
    expect(h.addOutputs.at(-1)).toMatchObject({
      owner: "human",
      blockedReason: "decision",
      why: "Which region should the bucket live in?",
    });
    const added = byLabel.get("Which region should the bucket live in?");
    expect(added).toBeDefined();
    expect(added!.retiredAt).toBeUndefined();
  });
});
