/**
 * "This session needs you" — the ONE producer of `session.needs_you`.
 *
 * WHY. An agent that hands work to the person (an `owner: 'human'` slot:
 * block_output, an `addOutput` with `owner: 'human'`, a PATCH/create that
 * declares one, a followed playbook's unanswered param) used to land it in the
 * needs-you tray and say nothing — the person saw it only if they opened the
 * app and looked (research brief 2026-09-25, M1). A room question from an agent
 * (`post_message` with `kind: 'question'`) is the same news. Both push ONCE per
 * session inside {@link SESSION_ATTENTION_DEDUPE_WINDOW_MS}: the registry row
 * declares a session-keyed `dedupeWindowMs`, so a storm of slots and questions
 * in one working block is one interruption, never N.
 *
 * WHO IS NOT TOLD. The person about their OWN writes — a write with no acting
 * agent is the human, and handing yourself work is not news. That is the only
 * actor rule (`byAgent`); every door derives it from the agent principal it
 * already verified. A headless playbook run (automation, cron) counts as an
 * agent: nobody is in front of it.
 *
 * WHAT COUNTS AS NEW. A slot owed in `after` (`isOwedSlot`, the predicate the
 * needs-you read uses) whose label was NOT owed in `before`. An echoed array
 * that merely repeats an old block is not a new hand-off.
 *
 * Side effect only: never throws, never gates the write it follows, never
 * touches governance (`NotificationService.create` is itself non-fatal).
 */
import { db, focusSessions, eq } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { Ask } from "@synap-core/types/ask";
import {
  blockingAskTarget,
  quickAnswerFor,
  type PushTarget,
} from "@synap-core/types/push";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../notifications/NotificationService.js";
import { isOwedSlot } from "./owed-outputs.js";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";

const logger = createLogger({ module: "notify-needs-you" });

/**
 * Declared lower-case first, deliberately: `notification-producer-allowlist.test.ts`
 * proves a registry row has a producer by scanning for the literal next to a
 * case-SENSITIVE `(type|notificationType)\s*[:=?]` (same trick as `record.ts`).
 */
const notificationType = "session.needs_you" as const;
export const SESSION_NEEDS_YOU_NOTIFICATION_TYPE = notificationType;

/** The session is the identity: one push per session per dedupe window. */
export function sessionNeedsYouGroupKey(sessionId: string): string {
  return `${SESSION_NEEDS_YOU_NOTIFICATION_TYPE}:${sessionId}`;
}

/** Longest `why` / question quoted in the notification body. */
const SUMMARY_MAX = 160;

function clip(s: string): string {
  const t = s.trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1)}…` : t;
}

/**
 * The slots this write newly handed to the person. Pure. Keyed on the
 * normalized label, like every other slot diff (`newlyBlockedSlots`).
 */
export function newlyOwedSlots(
  before: readonly ExpectedOutput[] | null | undefined,
  after: readonly ExpectedOutput[] | null | undefined
): ExpectedOutput[] {
  const owedBefore = new Set<string>();
  for (const o of before ?? []) {
    if (o && typeof o === "object" && isOwedSlot(o)) {
      const key = normalizeExpectedLabel(o.label);
      if (key) owedBefore.add(key);
    }
  }
  return (after ?? []).filter(
    (o) =>
      !!o &&
      typeof o === "object" &&
      isOwedSlot(o) &&
      !owedBefore.has(normalizeExpectedLabel(o.label) ?? "")
  );
}

/**
 * "Stripe key — the live account's restricted key (+1 more)". Pure. The
 * question is the slot's `why`, else its ask's own prompt (a `confirm` may
 * carry its question there and nowhere else), so the push says what is asked.
 */
export function summarizeOwedSlots(slots: readonly ExpectedOutput[]): string {
  const [first, ...rest] = slots;
  if (!first) return "";
  const question =
    first.why?.trim() ||
    (first.ask?.mode === "confirm" ? first.ask.prompt?.trim() : undefined);
  const head = question ? `${first.label} — ${question}` : first.label;
  return `${clip(head)}${rest.length > 0 ? ` (+${rest.length} more)` : ""}`;
}

/**
 * Where the push lands and what can be answered from the lock screen, for the
 * slots this write newly owed. ONE fresh slot ⇒ the ask itself
 * (`/owed/<sessionId>?slot=<label>`) and, when its ask allows, a quick answer
 * bound to the ask's fingerprint. Several ⇒ the session (no slot is guessed,
 * and no quick answer: the push would answer one of N silently). Pure.
 */
export function needsYouPush(
  sessionId: string,
  fresh: readonly ExpectedOutput[]
): {
  target: Extract<PushTarget, { kind: "owed" | "session" }>;
  slot?: string;
  quickAnswer: ReturnType<typeof quickAnswerFor>;
} {
  const target = blockingAskTarget(
    sessionId,
    fresh.map((o) => o.label)
  ) as Extract<PushTarget, { kind: "owed" | "session" }>;
  if (target.kind !== "owed") return { target, quickAnswer: null };
  return {
    target,
    slot: target.slot,
    // `SlotAsk` is the compile-time mutual mirror of `Ask` (see
    // update-session.ts), and the fingerprint is computed from the same
    // stored shape the answer door re-reads.
    quickAnswer: quickAnswerFor(
      { sessionId, label: target.slot },
      (fresh[0]?.ask ?? null) as Ask | null
    ),
  };
}

type Reason =
  | { kind: "slots"; before: unknown; after: unknown }
  | { kind: "question"; text: string; channelId: string };

/**
 * Tell the session's owner the session needs them. Returns true when a
 * notification row was written (false: nothing new, a human's own write, a
 * missing session, or the dedupe window already holds one).
 */
export async function notifySessionNeedsYou(p: {
  sessionId: string;
  /**
   * WHO handed it over. `true` ⇒ an agent (or a headless run nobody is
   * watching) — the person is told. `false` ⇒ the person did it themselves ⇒
   * no notification. Doors derive it from the agent principal they already
   * verified (`!!agentUserId`), never from a body field.
   */
  byAgent: boolean;
  /**
   * Who to tell, when it is not the session's `userId`. An agent-started RUN
   * is owned by the agent user (`run-playbook.ts` `actorId`), so the run door
   * names the person (`input.userId`) explicitly.
   */
  recipientUserId?: string;
  reason: Reason;
}): Promise<boolean> {
  if (!p.byAgent) return false;
  try {
    let summary: string;
    let slotCount = 0;
    let fresh: ExpectedOutput[] = [];
    if (p.reason.kind === "slots") {
      fresh = newlyOwedSlots(
        Array.isArray(p.reason.before)
          ? (p.reason.before as ExpectedOutput[])
          : [],
        Array.isArray(p.reason.after)
          ? (p.reason.after as ExpectedOutput[])
          : []
      );
      if (fresh.length === 0) return false;
      slotCount = fresh.length;
      summary = summarizeOwedSlots(fresh);
    } else {
      summary = clip(p.reason.text);
      if (!summary) return false;
    }

    const session = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, p.sessionId),
      columns: {
        id: true,
        userId: true,
        workspaceId: true,
        title: true,
        goal: true,
      },
    });
    if (!session) return false;

    const push = fresh.length > 0 ? needsYouPush(session.id, fresh) : null;

    const id = await NotificationService.create({
      type: SESSION_NEEDS_YOU_NOTIFICATION_TYPE,
      // The session's OWNER — for an agent key that is its operator.
      userId: p.recipientUserId ?? session.userId,
      workspaceId: session.workspaceId ?? null,
      sourceType: "session",
      // The SESSION is the destination (the registry's navigate-object action
      // and the push tap both read `sourceId` as the object id).
      sourceId: session.id,
      groupKey: sessionNeedsYouGroupKey(session.id),
      // The push lands on the ASK when one slot is owed (the in-app row keeps
      // its registry action: open the session). A room question keeps the
      // session target the registry derives.
      ...(push
        ? {
            target: { kind: push.target.kind, id: push.target.id },
            push: {
              slot: push.slot,
              quickAnswer: push.quickAnswer,
              threadId: session.id,
            },
          }
        : { push: { threadId: session.id } }),
      data: {
        sessionId: session.id,
        sessionTitle: resolveSessionTitle(session),
        summary,
        reason: p.reason.kind,
        ...(slotCount > 0 ? { slotCount } : {}),
        ...(p.reason.kind === "question"
          ? { channelId: p.reason.channelId }
          : {}),
      },
    });
    return !!id;
  } catch (err) {
    // A failed notification must never fail the hand-off it follows.
    logger.warn(
      { err, sessionId: p.sessionId },
      "session.needs_you notification failed"
    );
    return false;
  }
}
