/**
 * `synap_ask_person` — THE door any AI uses to put ONE item in front of the
 * person (founder, 2026-11-04: "one store, two roles"; research 353be97e §4.1).
 *
 * ONE STORE. It writes exactly the owed ask an agent inside a session writes
 * with `synap_update_session` (`owner: 'human'` + `ask` on the session's
 * `expected_outputs`), through the SAME service (`updateFocusSession`: its
 * governance membrane, ask provenance stamp, `owedSince`, `slot_asked` event
 * and `session.needs_you` producer). No second inbox, no parallel status:
 * Needs you stays the one read rule over every owed ask
 * (`@synap-core/types/needs-you/rule`).
 *
 * WHERE IT FILES, first that applies:
 *   1. the open ask THIS agent filed earlier with the same `dedupeKey`
 *      (updated in place, never a second card);
 *   2. a `sessionId` it names (its own, open), else the session bound to THIS
 *      caller (`findClientSession` on the request's client key: the session
 *      its conversation started, else its write receipt). NEVER the person's
 *      one unclaimed open session (`resolveWorkSession` rung 3): an outside
 *      AI's ask must not land in the person's unrelated work;
 *   3. the asker's ONE standing "Asks from <agent>" session (opened on its
 *      first ask, with no criteria asked of the caller): never one session
 *      per ask, which would escape the per-session push dedupe.
 *
 * The PRIORITY is not the caller's: the needs-you read derives P0-P3
 * (`needsYouPriority`); `urgency` can only lower it. The priority ranks; this
 * door changes no push behaviour (every ask notifies as before).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  ASK_ANSWER_BY_PAST_MESSAGE,
  ASK_LIMITS,
  AskSchema,
  isAskAnswerByPast,
  type Ask,
} from "@synap-core/types/ask";
import { isUuid } from "@synap-core/types/property-render";
import { needsYouPriority } from "@synap-core/types/needs-you";
import { refuseUndeclaredArgs } from "../undeclared-args.js";
import { ok, requireScope, type McpHandlerMap } from "./shared.js";

/** The slot kind an ask filed through this door carries. */
export const ASK_PERSON_SLOT_KIND = "ask";

/** A question is ONE line: the slot's label, the card's heading. */
const ASK_PERSON_QUESTION_MAX = ASK_LIMITS.questionMaxChars;

/** The ticket fields the door takes at top level and folds into the `ask`. */
const TICKET_ARGS = [
  "urgency",
  "answerBy",
  "consequence",
  "reversible",
  "dedupeKey",
] as const;

/**
 * What would unblock the asker, by the ask's mode — the card's chip when the
 * caller names none: a choice is a `decision`, a deed in the world is
 * `physical`, a secret or a connection is a `credential`.
 */
export function blockedReasonForAsk(
  ask: Pick<Ask, "mode"> & { provide?: { kind?: string } }
): NonNullable<ExpectedOutput["blockedReason"]> {
  if (ask.mode === "act") return "physical";
  if (ask.mode === "provide") {
    return ask.provide?.kind === "file" ? "physical" : "credential";
  }
  return "decision";
}

/**
 * The client key that marks an asker's STANDING asks session. Never a
 * request's client key (those are `key:` / `agent:` / `channel:` / per-call),
 * so the session attracts none of the asker's other writes, and it is never
 * the "one unclaimed open session" every other conversation would fall into
 * (`resolveWorkSession` rung 3 reads only sessions with no client key).
 */
export function standingAsksClientKey(
  agentUserId: string | undefined,
  userId: string
): string {
  return agentUserId ? `asks:agent:${agentUserId}` : `asks:person:${userId}`;
}

/**
 * The asker's ONE standing "Asks from <agent>" session: its open one, else a
 * new one (no criteria asked of the caller — its deliverables ARE the asks).
 *
 * Why one per asker, not one per ask (effects review ef0d7294 §0.5): a
 * `session.needs_you` push is deduped per SESSION (6 h), and attribution
 * declines when several sessions are open, so a fresh session per call would
 * be a fresh push per call. One standing session keeps an outside AI's asks in
 * one place and under one dedupe window.
 */
async function standingAskSession(input: {
  userId: string;
  agentUserId?: string;
}): Promise<
  | { status: "ok"; sessionId: string }
  | { status: "proposed"; proposalId: string; reviewUrl?: string }
> {
  const { db, focusSessions, users, and, eq, inArray, desc, drizzleSql } =
    await import("@synap/database");
  const { OPEN_SESSION_STATUSES } =
    await import("../../../services/focus-sessions/session-statuses.js");
  const clientKey = standingAsksClientKey(input.agentUserId, input.userId);
  const [open] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, input.userId),
        inArray(
          focusSessions.status,
          OPEN_SESSION_STATUSES.filter((st) => st !== "scheduled")
        ),
        drizzleSql`${focusSessions.metadata} ->> 'clientKey' = ${clientKey}`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: one row by its asker's marker, not a list door.
    .orderBy(desc(focusSessions.startedAt))
    .limit(1);
  if (open) return { status: "ok", sessionId: open.id };

  const [asker] = input.agentUserId
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, input.agentUserId))
        .limit(1)
    : [];
  const name = asker?.name?.trim() || (input.agentUserId ? "an agent" : "you");
  const { createFocusSession } =
    await import("../../../services/focus-sessions/create-session.js");
  const created = await createFocusSession({
    userId: input.userId,
    agentUserId: input.agentUserId,
    title: `Asks from ${name}`,
    goal: `Answer what ${name} asks you`,
    // Its deliverables are the asks themselves: no NO_CRITERIA refusal.
    requireCriteria: false,
    clientKey,
    // Never turn a conversation's write receipt into the asks session.
    adoptAutoOpened: false,
    // The marker lookup above IS the dedupe: the goal twin check matches by
    // goal text, so two agents with one display name would share a session.
    forceCreate: true,
  });
  if (created.status === "proposed") {
    return {
      status: "proposed",
      proposalId: created.proposalId,
      ...(created.reviewUrl ? { reviewUrl: created.reviewUrl } : {}),
    };
  }
  return { status: "ok", sessionId: created.session.id };
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * The OPEN ask this agent filed with `dedupeKey`, on any open session of the
 * person's, or null. EXACT in SQL — the session holds a slot that is owed
 * (`owedSlotPredicateSql`, THE owed-slot predicate), unanswered, asked by this
 * agent, with this key — so no page window can hide it; the slot is then
 * picked in TypeScript with the same rule (`isOwedSlot`). An answered, done or
 * withdrawn ask is never reopened.
 */
async function findDedupedAsk(input: {
  userId: string;
  agentUserId: string;
  dedupeKey: string;
}): Promise<{ sessionId: string; slot: ExpectedOutput } | null> {
  const {
    db,
    focusSessions,
    and,
    eq,
    inArray,
    desc,
    drizzleSql,
    owedSlotPredicateSql,
  } = await import("@synap/database");
  const { OPEN_SESSION_STATUSES } =
    await import("../../../services/focus-sessions/session-statuses.js");
  const { isOwedSlot } =
    await import("../../../services/focus-sessions/owed-outputs.js");
  const [row] = await db
    .select({ id: focusSessions.id, outputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, input.userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(${focusSessions.expectedOutputs}) = 'array'
                 THEN ${focusSessions.expectedOutputs}
                 ELSE '[]'::jsonb END
          ) AS slot
          WHERE ${owedSlotPredicateSql}
            AND slot->>'askedBy' = ${input.agentUserId}
            AND slot->'ask'->>'dedupeKey' = ${input.dedupeKey}
            AND slot->'answer' IS NULL
        )`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: a dedupe lookup by the asker's own key, not a
    // list door — the open session holding THIS agent's ask, whatever its kind.
    .orderBy(desc(focusSessions.updatedAt))
    .limit(1);
  if (!row) return null;
  const outputs = Array.isArray(row.outputs)
    ? (row.outputs as ExpectedOutput[])
    : [];
  const slot = outputs.find(
    (o) =>
      o?.askedBy === input.agentUserId &&
      o.ask?.dedupeKey === input.dedupeKey &&
      o.answer === undefined &&
      isOwedSlot(o)
  );
  return slot ? { sessionId: row.id, slot } : null;
}

export const askPersonHandlers: McpHandlerMap = {
  synap_ask_person: async (ctx): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const undeclared = await refuseUndeclaredArgs("synap_ask_person", args);
    if (undeclared) return undeclared;

    // ── The ticket, parsed by THE slot wire schema (the ask by `AskSchema`) ──
    const question = text(args.question);
    if (!question || question.length > ASK_PERSON_QUESTION_MAX) {
      return ok({
        error: `question is required: ONE line of at most ${ASK_PERSON_QUESTION_MAX} characters, the thing you need the person to answer. NOTHING WAS FILED.`,
      });
    }
    if (!args.ask || typeof args.ask !== "object" || Array.isArray(args.ask)) {
      return ok({
        error:
          "ask is required: HOW the person answers — {mode:'confirm'} | {mode:'choose', options:[…]} | {mode:'form', form:{fields:[…]}} | {mode:'act', steps:[…]} | {mode:'provide', provide:{…}}. NOTHING WAS FILED.",
      });
    }
    const askArg = AskSchema.safeParse(args.ask);
    if (!askArg.success) {
      return ok({
        error: `Invalid ask — NOTHING WAS FILED: ${askArg.error.issues
          .map((i) => `ask.${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
    }
    // The top-level ticket fields ride the ask (where they are stored); the
    // slot parse below re-checks the merged ask with the same schema.
    const rawAsk: Record<string, unknown> = { ...askArg.data };
    for (const k of TICKET_ARGS) {
      if (args[k] !== undefined) rawAsk[k] = args[k];
    }
    const { expectedOutputWireSchema } =
      await import("../../../services/focus-sessions/update-session.js");
    const parsed = expectedOutputWireSchema.safeParse({
      kind: ASK_PERSON_SLOT_KIND,
      label: question,
      owner: "human",
      ...(args.blockedReason !== undefined
        ? { blockedReason: args.blockedReason }
        : {}),
      ...(args.why !== undefined ? { why: args.why } : {}),
      ...(args.unblocks !== undefined ? { unblocks: args.unblocks } : {}),
      ...(args.ref !== undefined ? { ref: args.ref } : {}),
      ask: rawAsk,
    });
    if (!parsed.success) {
      return ok({
        error: `Invalid ask — NOTHING WAS FILED: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "ask"}: ${i.message}`)
          .join("; ")}`,
      });
    }
    const ask = parsed.data.ask as Ask;
    // Before any session is opened for it: a deadline already past is refused
    // here as at every write door (`isAskAnswerByPast`).
    if (isAskAnswerByPast(ask.answerBy)) {
      return ok({ error: `${ASK_ANSWER_BY_PAST_MESSAGE} NOTHING WAS FILED.` });
    }
    const slot: ExpectedOutput = {
      ...parsed.data,
      blockedReason: parsed.data.blockedReason ?? blockedReasonForAsk(ask),
    };

    // ── Where it files ───────────────────────────────────────────────────────
    const named = text(args.sessionId);
    if (named && !isUuid(named)) {
      return ok({
        error: `sessionId must be a session UUID — NOTHING WAS FILED.`,
      });
    }
    let sessionId: string | undefined;
    let filedOn: "dedupe" | "named" | "conversation" | "standing";
    let slotKey: string | undefined;
    const deduped =
      agentUserId && ask.dedupeKey
        ? await findDedupedAsk({
            userId,
            agentUserId,
            dedupeKey: ask.dedupeKey,
          })
        : null;
    if (deduped) {
      sessionId = deduped.sessionId;
      slotKey = deduped.slot.key;
      filedOn = "dedupe";
    } else if (named) {
      // The adapter resolved the named handle (`resolveSessionHandle`): one
      // the caller does not own is DROPPED there, and filing elsewhere would
      // put the person's answer where the caller never looks.
      if (ctx.sessionId !== named) {
        return ok({
          error: `Focus session ${named} is not one of yours — NOTHING WAS FILED. Omit sessionId to file it on your conversation's session or your standing asks session.`,
        });
      }
      sessionId = named;
      filedOn = "named";
    } else {
      // Only the session bound to THIS caller (its conversation's own, else
      // its write receipt) — never the adapter's rung-3 guess, the person's
      // one unclaimed open session, which is unrelated work for an outside AI.
      const [{ findClientSession }, { requestClientKey }] = await Promise.all([
        import("@synap/database"),
        import("../../../services/focus-sessions/resolve-work-session.js"),
      ]);
      const clientKey = requestClientKey(agentUserId);
      const bound = clientKey
        ? await findClientSession(userId, clientKey)
        : null;
      if (bound) {
        sessionId = bound.id;
        filedOn = "conversation";
      } else {
        filedOn = "standing";
      }
    }

    // An ask on an ENDED session reaches nobody (pod finding 619aa1e3).
    if (sessionId && filedOn !== "dedupe") {
      const { db, focusSessions, and, eq } = await import("@synap/database");
      const { isTerminalSessionStatus } =
        await import("../../../services/focus-sessions/session-statuses.js");
      const [row] = await db
        .select({ status: focusSessions.status })
        .from(focusSessions)
        .where(
          and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
        )
        .limit(1);
      if (!row) {
        return ok({
          error: `Focus session ${sessionId} not found — NOTHING WAS FILED.`,
        });
      }
      if (isTerminalSessionStatus(row.status)) {
        if (filedOn === "named") {
          return ok({
            error: `Focus session ${sessionId} has ended (${row.status}): an ask there reaches nobody — NOTHING WAS FILED. Omit sessionId to file it on your standing asks session.`,
          });
        }
        sessionId = undefined;
        filedOn = "standing";
      }
    }

    if (!sessionId) {
      const standing = await standingAskSession({ userId, agentUserId });
      if (standing.status === "proposed") {
        return ok({
          status: "proposed",
          filedOn,
          proposalId: standing.proposalId,
          reviewUrl: standing.reviewUrl,
          message:
            "Opening the session that holds your asks needs the person's approval first: nothing is in front of them yet, and your ask was NOT filed. Do not retry; ask again once it is approved, or name a session you own with sessionId.",
        });
      }
      sessionId = standing.sessionId;
    }

    // ── File it: THE owed-ask write (`updateFocusSession`) ───────────────────
    const { updateFocusSession } =
      await import("../../../services/focus-sessions/update-session.js");
    const result = await updateFocusSession({
      sessionId,
      userId,
      agentUserId,
      // Upserted by key (a dedupe hit) or label: asking the same thing again
      // on the same session updates it, never a second card.
      expectedOutputs: [slotKey ? { ...slot, key: slotKey } : slot],
    });
    if (result.status === "not_found") {
      return ok({
        error: `Focus session ${sessionId} not found — NOTHING WAS FILED.`,
      });
    }
    if (result.status === "denied") {
      return ok({ status: "denied", error: result.reason, sessionId });
    }
    if (result.status === "proposed") {
      return ok({ ...result, sessionId, filedOn });
    }
    if (result.status !== "updated") return ok({ ...result, sessionId });

    // What the needs-you read will derive once the asker is not working (it
    // just stopped on this ask): said here so the caller knows, never stored.
    const expectedPriority = needsYouPriority({
      needsYouClass: "needs_you",
      urgency: ask.urgency,
      answerBy: ask.answerBy,
    });
    return ok({
      status: deduped ? "updated" : "asked",
      sessionId,
      filedOn,
      question,
      expectedPriority,
      // An ask filed with the PERSON's own key (no agent principal) lands in
      // Needs you but never rings their phone (`notifySessionNeedsYou` tells
      // the person only what an agent handed them).
      ...(agentUserId
        ? {}
        : {
            pushes: false,
            note: "Filed with the person's own key: it is in their Needs you, but no notification is sent for it. Use an agent key for the person to be told.",
          }),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      next: `Wait for the answer with synap_wait_for_answer({sessionId: "${sessionId}"}); if the person answers you in this chat instead, relay their words with synap_relay_answer({sessionId: "${sessionId}", slotLabel: ${JSON.stringify(question)}, disposition: "answered", quote}).`,
    });
  },
};
