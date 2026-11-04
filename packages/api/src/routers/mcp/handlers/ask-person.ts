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
 *   2. the session this call is attributed to — a `sessionId` it names (its
 *      own, open), else the pod's automatic grouping (`resolveSessionHandle`
 *      → `resolveWorkSession`: the conversation's session, else the person's
 *      one unclaimed open session), handed in as `ctx.sessionId`;
 *   3. a small one-ask session opened for it, named by the question, with no
 *      criteria asked of the caller (the answer is its only deliverable).
 *
 * The PRIORITY is not the caller's: the needs-you read derives P0-P3
 * (`needsYouPriority`); `urgency` can only lower it. This door changes no push
 * behaviour.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExpectedOutput } from "@synap/playbooks";
import { ASK_LIMITS, type Ask } from "@synap-core/types/ask";
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

/** A one-ask session's goal: the question, said as the outcome. */
function oneAskGoal(question: string): string {
  return `Get the person's answer: ${question}`;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * The OPEN ask this agent filed with `dedupeKey`, on any open session of the
 * person's, or null. Read with JSONB containment on the stored array, then
 * the slot is picked in TypeScript with the owed predicate (`isOwedSlot`, the
 * one the needs-you read uses), so an answered, done or withdrawn ask is never
 * reopened.
 */
async function findDedupedAsk(input: {
  userId: string;
  agentUserId: string;
  dedupeKey: string;
}): Promise<{ sessionId: string; slot: ExpectedOutput } | null> {
  const { db, focusSessions, and, eq, inArray, desc, drizzleSql } =
    await import("@synap/database");
  const { OPEN_SESSION_STATUSES } =
    await import("../../../services/focus-sessions/session-statuses.js");
  const { isOwedSlot } =
    await import("../../../services/focus-sessions/owed-outputs.js");
  const probe = JSON.stringify([
    { askedBy: input.agentUserId, ask: { dedupeKey: input.dedupeKey } },
  ]);
  const rows = await db
    .select({ id: focusSessions.id, outputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, input.userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`${focusSessions.expectedOutputs} @> ${probe}::jsonb`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: a dedupe lookup by the asker's own key, not a
    // list door — any open session holding THIS agent's ask, whatever its kind.
    .orderBy(desc(focusSessions.updatedAt))
    .limit(5);
  for (const row of rows) {
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
    if (slot) return { sessionId: row.id, slot };
  }
  return null;
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
    const rawAsk: Record<string, unknown> = {
      ...(args.ask as Record<string, unknown>),
    };
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
    let filedOn: "dedupe" | "named" | "attributed" | "new";
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
          error: `Focus session ${named} is not one of yours — NOTHING WAS FILED. Omit sessionId to file it where your writes are grouped.`,
        });
      }
      sessionId = named;
      filedOn = "named";
    } else if (ctx.sessionId) {
      sessionId = ctx.sessionId;
      filedOn = "attributed";
    } else {
      filedOn = "new";
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
            error: `Focus session ${sessionId} has ended (${row.status}): an ask there reaches nobody — NOTHING WAS FILED. Omit sessionId to file it on its own.`,
          });
        }
        sessionId = undefined;
        filedOn = "new";
      }
    }

    if (!sessionId) {
      const [{ createFocusSession }, { requestClientKey }] = await Promise.all([
        import("../../../services/focus-sessions/create-session.js"),
        import("../../../services/focus-sessions/resolve-work-session.js"),
      ]);
      const created = await createFocusSession({
        userId,
        agentUserId,
        // A personal session (no space) unless the caller's lens names a
        // project: the ask is the person's, wherever the asker works.
        projectId: text(args.projectId),
        title: question,
        goal: oneAskGoal(question),
        // The one-ask session's only deliverable IS the answer: no criteria
        // are asked of the caller (no NO_CRITERIA refusal on this door).
        requireCriteria: false,
        // Bound to this conversation, as `synap_start_session` binds: its next
        // writes group here, and an unbound agent session would become every
        // other conversation's "one unclaimed open session" (rung 3).
        clientKey: requestClientKey(agentUserId) ?? null,
        // Never turn the conversation's write receipt into this ask's session.
        adoptAutoOpened: false,
      });
      if (created.status === "proposed") {
        return ok({
          status: "proposed",
          filedOn,
          proposalId: created.proposalId,
          reviewUrl: created.reviewUrl,
          message:
            "Opening the session that holds your ask needs the person's approval first: nothing is in front of them yet, and your ask was NOT filed. Do not retry; ask again once it is approved, or name a session you own with sessionId.",
        });
      }
      sessionId = created.session.id;
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
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      next: `Wait for the answer with synap_wait_for_answer({sessionId: "${sessionId}"}); if the person answers you in this chat instead, relay their words with synap_relay_answer({sessionId: "${sessionId}", slotLabel: ${JSON.stringify(question)}, disposition: "answered", quote}).`,
    });
  },
};
