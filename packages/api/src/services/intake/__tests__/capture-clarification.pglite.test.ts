/**
 * CAPTURE CLARIFICATION — the question persists in the session's room, and an
 * answer claims it by compare-and-set, on a real Postgres (PGlite).
 *
 * Driven through the real `persistCaptureQuestion` → `ensureSessionChannel` →
 * `recordCapturePartMessage` → `rememberIntakeClarification`, and the real
 * `claimCaptureQuestion`. Every assertion reads rows back. DDL is derived from
 * the drizzle tables.
 *
 * Stubbed: `emitChatEvent` (realtime fan-out; recorded so the emit is asserted).
 *
 * NOT covered here (NEEDS-DOGFOOD): the `capture.structure` / `answerFollowUp`
 * procedures end to end — they need the IS. Their wiring is pinned by
 * `capture-part-no-agent-turn.tripwire.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  emitted: [] as Array<{ event: string; data: unknown }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (o: { event: string; data: unknown }) => {
    holder.emitted.push(o);
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { TRPCError } from "@trpc/server";
import { focusSessions, channels, messages } from "@synap/database";
import {
  SKIP_FOLLOW_UP_INSTRUCTION,
  captureAnswerMessageId,
  captureClarificationAnswered,
  captureQuestionMessageId,
  claimCaptureQuestion,
  followUpIsAsked,
  persistCaptureQuestion,
  questionFromFollowUp,
  restructureInput,
} from "../capture-clarification.js";
import {
  CAPTURE_PART_LIMITS,
  readCapturePart,
} from "@synap-core/types/capture";

describe("proposal fields — why / recommended / description", () => {
  it("round-trip through persist into a part the contract accepts", async () => {
    const sessionId = await seedSession();
    const res = await persistCaptureQuestion({
      sessionId,
      userId: USER,
      followUp: {
        question: "How should this idea be framed?",
        why: "Decides what gets created.",
        suggestions: [
          {
            label: "A product bet",
            value: "bet",
            action: "confirm",
            recommended: true,
            description: "→ creates a positioning note + research question",
          },
          {
            label: "A research question",
            value: "q",
            action: "confirm",
            description: "→ files a question to investigate",
          },
        ],
      },
      partialCount: 1,
      refine: { text: "Idea: capture that proposes" },
    });
    expect(res.status).toBe("persisted");
    const [row] = await q<{ metadata: unknown }>(
      `select metadata from messages where id = $1`,
      [(res as { followUpMessageId: string }).followUpMessageId]
    );
    const stored = readCapturePart(row!.metadata);
    expect(stored).toMatchObject({
      kind: "capture_question",
      why: "Decides what gets created.",
      chips: [
        {
          label: "A product bet",
          recommended: true,
          description: "→ creates a positioning note + research question",
        },
        {
          label: "A research question",
          description: "→ files a question to investigate",
        },
      ],
    });
  });

  it("a second recommended chip is NORMALIZED away (first wins), bounds truncated, blanks dropped", () => {
    const out = questionFromFollowUp({
      question: "Q?",
      why: "w".repeat(CAPTURE_PART_LIMITS.whyMaxChars + 5),
      suggestions: [
        {
          label: "a",
          value: "a",
          action: "confirm",
          recommended: true,
          description: "d".repeat(
            CAPTURE_PART_LIMITS.chipDescriptionMaxChars + 5
          ),
        },
        {
          label: "b",
          value: "b",
          action: "confirm",
          recommended: true,
          description: "  ",
        },
      ],
    });
    expect(out.chips.filter((c) => c.recommended === true)).toHaveLength(1);
    expect(out.chips[0]!.recommended).toBe(true);
    expect("recommended" in out.chips[1]!).toBe(false);
    expect(out.why).toHaveLength(CAPTURE_PART_LIMITS.whyMaxChars);
    expect(out.chips[0]!.description).toHaveLength(
      CAPTURE_PART_LIMITS.chipDescriptionMaxChars
    );
    expect("description" in out.chips[1]!).toBe(false);
  });
});

const USER = "user-1";
const OTHER = "user-2";

/** CREATE TABLE from the drizzle definition (same helper as the other pglite suites). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

let client: PGlite;
const q = async <T>(sql: string, params?: unknown[]) =>
  (await client.query<T>(sql, params)).rows;

beforeEach(async () => {
  client = new PGlite();
  for (const t of [focusSessions, channels, messages]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  holder.db = drizzle(client, {
    schema: { focusSessions, channels, messages },
  });
  holder.emitted.length = 0;
});

async function seedSession(userId = USER): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into focus_sessions (user_id, goal, status, metadata)
     values ($1, 'Capture · Lunch with Alice', 'active', $2::jsonb) returning id`,
    [
      userId,
      JSON.stringify({ intake: { door: "capture", correlationKey: "k1" } }),
    ]
  );
  return row!.id;
}

async function part(id: string) {
  const [row] = await q<{ metadata: { capturePart: Record<string, any> } }>(
    `select metadata from messages where id = $1`,
    [id]
  );
  return row?.metadata.capturePart;
}

async function ask(sessionId: string, question = "Which Alice?") {
  const res = await persistCaptureQuestion({
    sessionId,
    userId: USER,
    followUp: {
      question,
      suggestions: [
        {
          label: "Alice Martin",
          value: "am",
          action: "link_entity",
          entityId: "e-1",
        },
      ],
    },
    partialCount: 2,
    refine: { text: "Lunch with Alice", instructions: "prefer contacts" },
  });
  if (res.status !== "persisted")
    throw new Error(`expected persisted, got ${res.status}`);
  return res;
}

describe("capture.structure persists the question", () => {
  it("in the session's THREAD room, with its deterministic id, round and open status", async () => {
    const sessionId = await seedSession();
    const res = await ask(sessionId);

    expect(res.followUpMessageId).toBe(captureQuestionMessageId(sessionId, 1));
    expect(res.round).toBe(1);

    const [channel] = await q<{
      channel_type: string;
      context_object_type: string;
      id: string;
    }>(`select id, channel_type, context_object_type from channels`);
    expect(channel).toMatchObject({
      id: res.channelId,
      channel_type: "thread",
      context_object_type: "focus_session",
    });

    const [msg] = await q<{
      role: string;
      author_type: string;
      content: string;
      channel_id: string;
    }>(
      `select role, author_type, content, channel_id from messages where id = $1`,
      [res.followUpMessageId]
    );
    expect(msg).toMatchObject({
      role: "assistant",
      author_type: "bot",
      content: "Which Alice?",
      channel_id: res.channelId,
    });
    expect(await part(res.followUpMessageId)).toMatchObject({
      kind: "capture_question",
      v: 1,
      sessionId,
      round: 1,
      status: "open",
      partialCount: 2,
      chips: [{ label: "Alice Martin", entityId: "e-1" }],
    });
    expect(holder.emitted).toHaveLength(1);

    // Refine inputs are server-only on the session, and the intake keys survive.
    const [session] = await q<{ metadata: Record<string, any> }>(
      `select metadata from focus_sessions where id = $1`,
      [sessionId]
    );
    expect(session!.metadata.intake).toMatchObject({
      door: "capture",
      correlationKey: "k1",
      clarification: {
        questionMessageId: res.followUpMessageId,
        round: 1,
        refine: { text: "Lunch with Alice", instructions: "prefer contacts" },
      },
    });
  });

  it("a new question on the same session SUPERSEDES the open one", async () => {
    const sessionId = await seedSession();
    const first = await ask(sessionId);
    const second = await ask(sessionId, "Which company?");

    expect(second.round).toBe(2);
    expect(await part(first.followUpMessageId)).toMatchObject({
      status: "superseded",
      resolvedByMessageId: second.followUpMessageId,
    });
    expect(await part(second.followUpMessageId)).toMatchObject({
      status: "open",
    });

    // The superseded question cannot be answered.
    await expect(
      claimCaptureQuestion({
        userId: USER,
        sessionId,
        questionMessageId: first.followUpMessageId,
        answer: { type: "text", text: "late" },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("capture.answerFollowUp claims the question", () => {
  it("compare-and-set: first answer wins, the same answer retries, a different one is CONFLICT", async () => {
    const sessionId = await seedSession();
    const { followUpMessageId } = await ask(sessionId);
    const answerId = captureAnswerMessageId(followUpMessageId);

    const first = await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: { type: "text", text: "Alice from Acme" },
    });
    expect(first).toMatchObject({
      outcome: "claimed",
      answerMessageId: answerId,
    });
    expect(first.refine).toMatchObject({ text: "Lunch with Alice" });
    expect(await part(followUpMessageId)).toMatchObject({
      status: "answered",
      resolvedByMessageId: answerId,
    });
    expect(await part(answerId)).toMatchObject({
      kind: "capture_answer",
      questionMessageId: followUpMessageId,
      answer: { type: "text", text: "Alice from Acme" },
    });
    const [answerRow] = await q<{ role: string; author_type: string }>(
      `select role, author_type from messages where id = $1`,
      [answerId]
    );
    expect(answerRow).toMatchObject({ role: "user", author_type: "human" });

    const retry = await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: { type: "text", text: "Alice from Acme" },
    });
    expect(retry.outcome).toBe("retry");

    const conflict = claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: { type: "text", text: "A different Alice" },
    });
    await expect(conflict).rejects.toBeInstanceOf(TRPCError);
    await expect(conflict).rejects.toMatchObject({ code: "CONFLICT" });

    // The winning answer is intact and there is exactly one answer row.
    expect(await part(answerId)).toMatchObject({
      answer: { text: "Alice from Acme" },
    });
    const [{ n }] = (await q<{ n: number }>(
      `select count(*)::int as n from messages where metadata -> 'capturePart' ->> 'kind' = 'capture_answer'`
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it("a skip after an answer is CONFLICT (a different resolution)", async () => {
    const sessionId = await seedSession();
    const { followUpMessageId } = await ask(sessionId);
    await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: {
        type: "chip",
        chip: { label: "Alice Martin", value: "am", action: "link_entity" },
      },
    });
    await expect(
      claimCaptureQuestion({
        userId: USER,
        sessionId,
        questionMessageId: followUpMessageId,
        answer: { type: "skip" },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a foreign session, or a question from another room, is NOT_FOUND", async () => {
    const mine = await seedSession();
    const { followUpMessageId } = await ask(mine);

    // Someone else answering my question with my session id.
    await expect(
      claimCaptureQuestion({
        userId: OTHER,
        sessionId: mine,
        questionMessageId: followUpMessageId,
        answer: { type: "text", text: "x" },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Their own session, my question id.
    const theirs = await seedSession(OTHER);
    await expect(
      claimCaptureQuestion({
        userId: OTHER,
        sessionId: theirs,
        questionMessageId: followUpMessageId,
        answer: { type: "text", text: "x" },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Untouched.
    expect(await part(followUpMessageId)).toMatchObject({ status: "open" });
  });

  it("skip: status skipped, and the re-run suppresses a residual followUp", async () => {
    const sessionId = await seedSession();
    const { followUpMessageId } = await ask(sessionId);
    const claim = await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: { type: "skip" },
    });
    expect(await part(followUpMessageId)).toMatchObject({ status: "skipped" });

    const rerun = restructureInput(claim.refine, { type: "skip" }, sessionId);
    expect(rerun).toMatchObject({
      text: "Lunch with Alice",
      sessionId,
      suppressFollowUp: true,
    });
    expect(rerun.instructions).toBe(
      `prefer contacts\n${SKIP_FOLLOW_UP_INSTRUCTION}`
    );
    expect("context" in rerun).toBe(false);

    // The structure branch gate: a followUp that comes back anyway is dropped.
    expect(followUpIsAsked("Which Alice?", rerun.suppressFollowUp)).toBe(false);
    expect(followUpIsAsked("Which Alice?", undefined)).toBe(true);
    expect(followUpIsAsked(null, undefined)).toBe(false);
  });

  it("CONFLICT carries a machine-readable status through the pod's REAL errorFormatter", async () => {
    const { t } = await import("../../../init-trpc.js");
    const format = (err: unknown) =>
      (
        t._config.errorFormatter as (o: unknown) => {
          data: Record<string, unknown>;
        }
      )({
        shape: {
          message: (err as Error).message,
          code: -32009,
          data: { code: (err as TRPCError).code, httpStatus: 409 },
        },
        error: err,
        type: "mutation",
        path: "capture.answerFollowUp",
        input: undefined,
        ctx: undefined,
      });

    const sessionId = await seedSession();
    const first = await ask(sessionId);
    const second = await ask(sessionId, "Which company?");

    // Superseded (the stale-refine branch).
    const superseded = await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: first.followUpMessageId,
      answer: { type: "text", text: "late" },
    }).catch((e: unknown) => e);
    expect(format(superseded).data).toMatchObject({
      code: "CONFLICT",
      captureQuestionStatus: "superseded",
    });

    // Already answered (the CAS branch).
    await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: second.followUpMessageId,
      answer: { type: "text", text: "Acme" },
    });
    const answered = await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: second.followUpMessageId,
      answer: { type: "skip" },
    }).catch((e: unknown) => e);
    expect(format(answered).data).toMatchObject({
      code: "CONFLICT",
      captureQuestionStatus: "answered",
    });

    // A NOT_FOUND carries no status.
    const missing = await claimCaptureQuestion({
      userId: OTHER,
      sessionId,
      questionMessageId: second.followUpMessageId,
      answer: { type: "skip" },
    }).catch((e: unknown) => e);
    expect(format(missing).data).not.toHaveProperty("captureQuestionStatus");
  });

  it("the claimed QUESTION reaches the re-run's context (read from the question row)", async () => {
    const sessionId = await seedSession();
    const { followUpMessageId } = await ask(
      sessionId,
      "Which Alice did you meet?"
    );
    const claim = await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: { type: "text", text: "Alice from Acme" },
    });
    expect(claim.refine.question).toBe("Which Alice did you meet?");
    const rerun = restructureInput(
      claim.refine,
      { type: "text", text: "Alice from Acme" },
      sessionId
    );
    expect(rerun.context).toBe(
      "Question: Which Alice did you meet?\nAlice from Acme"
    );
    // The question is a re-run input only — never forwarded as a structure field.
    expect("question" in rerun).toBe(false);
  });

  it("EVERY answer type re-runs with suppressFollowUp (one question per capture)", () => {
    const text = restructureInput(
      { text: "t", context: "earlier" },
      { type: "text", text: "Acme" },
      "s-1"
    );
    expect(text).toMatchObject({ context: "earlier\nAcme", sessionId: "s-1" });
    for (const answer of [
      {
        type: "chip",
        chip: { label: "Acme", value: "acme", action: "link_entity" },
      },
      { type: "text", text: "Acme" },
      { type: "form", values: { company: "Acme" } },
      { type: "skip" },
    ] as const) {
      const rerun = restructureInput({ text: "t" }, answer, "s-1");
      expect(rerun.suppressFollowUp, answer.type).toBe(true);
      expect(
        followUpIsAsked("Which Acme?", rerun.suppressFollowUp),
        answer.type
      ).toBe(false);
    }
  });

  it("a chip answer never yields a round-2 question: the gate reads answered, and persist refuses", async () => {
    const sessionId = await seedSession();
    const { followUpMessageId } = await ask(sessionId);
    expect(
      await captureClarificationAnswered({ sessionId, userId: USER })
    ).toBe(false);

    await claimCaptureQuestion({
      userId: USER,
      sessionId,
      questionMessageId: followUpMessageId,
      answer: {
        type: "chip",
        chip: { label: "Alice Martin", value: "am", action: "link_entity" },
      },
    });

    expect(
      await captureClarificationAnswered({ sessionId, userId: USER })
    ).toBe(true);
    // Not the owner → nothing to read (owner floor).
    expect(
      await captureClarificationAnswered({ sessionId, userId: OTHER })
    ).toBe(false);

    const again = await persistCaptureQuestion({
      sessionId,
      userId: USER,
      followUp: "And which company?",
      partialCount: 1,
      refine: { text: "Lunch with Alice" },
    });
    expect(again.status).toBe("refused");
    const [{ n }] = (await q<{ n: number }>(
      `select count(*)::int as n from messages where metadata -> 'capturePart' ->> 'kind' = 'capture_question'`
    )) as [{ n: number }];
    expect(n).toBe(1);
    expect(await part(followUpMessageId)).toMatchObject({ status: "answered" });
  });
});
