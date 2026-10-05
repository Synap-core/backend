/**
 * A `proposed` decision IS a question for the person (W3 of the decision mesh,
 * the inverse of W2's answer → decision).
 *
 * THE SEAM: every entity create/update door ends in `emitSideEffects`
 * (`recordDomainMutation` on the tRPC/MCP/Hub doors, the materializer on the
 * approval path) — it is how automations see entity writes at all. Hooking a
 * reactor there means ONE door, not one per router (the
 * `session-unblock-reactor.ts` IoC precedent: `@synap/events` cannot import
 * `@synap/api`, so the api process registers its own reactors at boot).
 *
 * ON `decisionStatus: 'proposed'` — ensure ONE owed human slot asks it:
 *   `{kind:'decision', owner:'human', blockedReason:'decision', ask, decisionId,
 *   ref → the decision}`. The ask is a `choose` over the decision's
 *   `decisionOptions` (recommended marked, or via `recommendedOption`), else a
 *   `confirm` on its title. HOME: the session it was created in (its
 *   `sourceSessionId`, else the writing request's session) when that session is
 *   the owner's and open; otherwise a minimal one-slot session
 *   "Decide: <title>". Answering the slot UPDATES the decision (W2,
 *   `slot.decisionId`).
 *
 * ON ANY OTHER STATUS — an owed slot still asking about it is moot (decided on
 * the entity itself): retired `decision_resolved`. An ANSWERED slot is left
 * alone — the agent still has to pick its answer up.
 *
 * IDEMPOTENT: never two open slots for one decision. Re-checked under the
 * session row lock.
 *
 * NEVER THROWS, NEVER SILENT: failures are logged at error level.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  entities,
  focusSessions,
} from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import {
  AskOptionSchema,
  AskSchema,
  askOptionKey,
  ASK_LIMITS,
  type AskOption,
} from "@synap-core/types/ask";
import {
  OPEN_SESSION_STATUSES,
  SESSION_TITLE_MAX,
} from "@synap-core/types/focus-sessions";
import { isOwedSlot } from "../focus-sessions/owed-outputs.js";
import { reconcileOwedSince } from "../focus-sessions/update-session.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import { logSlotsAsked } from "../focus-sessions/slot-asked-event.js";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";

const logger = createLogger({ module: "decision-ask-reactor" });

export const DECISION_PROFILE_SLUG = "decision";
const LABEL_MAX = 120;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type DecisionRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  properties: Record<string, unknown>;
  createdByKind: string | null;
};

// ─── Pure ───────────────────────────────────────────────────────────────────

/**
 * The ask for a proposed decision. `decisionOptions` (≥ 2 valid options) ⇒ a
 * `choose`, with the recommendation taken from an option's own flag or from
 * `recommendedOption` (at most one kept); anything less ⇒ a `confirm` on the
 * title. Parsed with the ONE ask schema — an option that does not parse is
 * dropped, never stored.
 */
export function askForDecision(
  title: string,
  properties: Record<string, unknown>
): SlotAsk {
  const raw = Array.isArray(properties.decisionOptions)
    ? properties.decisionOptions
    : [];
  const recommendedKey =
    typeof properties.recommendedOption === "string"
      ? properties.recommendedOption
      : null;
  const options: AskOption[] = [];
  for (const o of raw) {
    const parsed = AskOptionSchema.safeParse(o);
    if (parsed.success) options.push(parsed.data);
    if (options.length >= ASK_LIMITS.optionsMax) break;
  }
  if (options.length >= 2) {
    let recommendedSeen = false;
    const marked = options.map((o) => {
      const rec =
        !recommendedSeen &&
        (recommendedKey !== null
          ? askOptionKey(o) === recommendedKey
          : o.recommended === true);
      if (rec) recommendedSeen = true;
      const { recommended: _r, ...rest } = o;
      return rec ? { ...rest, recommended: true } : rest;
    });
    const ask = AskSchema.safeParse({ mode: "choose", options: marked });
    if (ask.success) return ask.data as SlotAsk;
  }
  return {
    mode: "confirm",
    prompt: clip(`Accept: ${title}?`, ASK_LIMITS.promptMaxChars),
  };
}

/** The owed slot that asks a proposed decision. Pure. */
export function decisionSlot(
  decision: Pick<DecisionRow, "id" | "title" | "properties">,
  takenLabels: ReadonlySet<string>,
  now: Date = new Date()
): ExpectedOutput {
  const title = (decision.title ?? "").trim() || "Untitled decision";
  let label = clip(`Decide: ${title}`, LABEL_MAX);
  if (takenLabels.has(normalizeExpectedLabel(label) ?? "")) {
    label = `${clip(`Decide: ${title}`, LABEL_MAX - 11)} (${decision.id.slice(0, 8)})`;
  }
  const summary =
    typeof decision.properties.summary === "string"
      ? decision.properties.summary.trim()
      : "";
  return reconcileOwedSince(
    {
      kind: "decision",
      label,
      status: "pending",
      owner: "human",
      blockedReason: "decision",
      why: clip(summary || title, 500),
      ref: { kind: "entity", id: decision.id },
      ask: askForDecision(title, decision.properties),
      decisionId: decision.id,
    },
    now
  );
}

/** Is this slot STILL ASKING about the decision (owed, unanswered)? Pure. */
export function isOpenDecisionAsk(
  slot: ExpectedOutput,
  decisionId: string
): boolean {
  return slot?.decisionId === decisionId && isOwedSlot(slot) && !slot.answer;
}

/** Retire the slots still asking about a resolved decision. Pure; null = no change. */
export function retireResolvedDecisionAsks(
  outputs: ExpectedOutput[],
  decisionId: string,
  now: Date = new Date()
): ExpectedOutput[] | null {
  let changed = false;
  const next = outputs.map((o) => {
    if (!isOpenDecisionAsk(o, decisionId)) return o;
    changed = true;
    return {
      ...o,
      retiredAt: now.toISOString(),
      retiredReason: "decision_resolved" as const,
    };
  });
  return changed ? next : null;
}

// ─── Effects ────────────────────────────────────────────────────────────────

async function loadDecision(id: string): Promise<DecisionRow | null> {
  const [row] = await db
    .select({
      id: entities.id,
      userId: entities.userId,
      workspaceId: entities.workspaceId,
      title: entities.title,
      properties: entities.properties,
      type: entities.type,
      createdByKind: entities.createdByKind,
      deletedAt: entities.deletedAt,
    })
    .from(entities)
    .where(eq(entities.id, id))
    .limit(1);
  if (!row || row.deletedAt || row.type !== DECISION_PROFILE_SLUG) return null;
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId ?? null,
    title: row.title ?? null,
    properties:
      row.properties && typeof row.properties === "object"
        ? (row.properties as Record<string, unknown>)
        : {},
    createdByKind: row.createdByKind ?? null,
  };
}

/** The owner's OPEN sessions carrying a slot for this decision. */
async function sessionsCarrying(decision: DecisionRow) {
  return db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, decision.userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`${focusSessions.expectedOutputs} @> ${JSON.stringify([
          { decisionId: decision.id },
        ])}::jsonb`
      )
    );
}

async function openHome(
  decision: DecisionRow,
  candidates: Array<string | null | undefined>
): Promise<string | null> {
  for (const id of candidates) {
    if (!id || typeof id !== "string") continue;
    const [row] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, id),
          eq(focusSessions.userId, decision.userId),
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .limit(1);
    if (row) return row.id;
  }
  return null;
}

/** Ensure ONE owed slot asks this proposed decision. Returns the session id. */
export async function ensureDecisionAsk(
  decision: DecisionRow,
  writingSessionId: string | null | undefined
): Promise<{ sessionId: string; created: boolean } | null> {
  const carrying = await sessionsCarrying(decision);
  for (const s of carrying) {
    const outs = Array.isArray(s.expectedOutputs)
      ? (s.expectedOutputs as ExpectedOutput[])
      : [];
    if (outs.some((o) => isOpenDecisionAsk(o, decision.id))) {
      return { sessionId: s.id, created: false };
    }
  }

  let homeId = await openHome(decision, [
    typeof decision.properties.sourceSessionId === "string"
      ? decision.properties.sourceSessionId
      : null,
    writingSessionId,
  ]);
  if (!homeId) {
    const { createFocusSession } =
      await import("../focus-sessions/create-session.js");
    const title = clip(
      `Decide: ${(decision.title ?? "").trim() || "Untitled decision"}`,
      SESSION_TITLE_MAX
    );
    const projectId =
      typeof decision.properties.projectId === "string"
        ? decision.properties.projectId
        : null;
    const res = await createFocusSession({
      userId: decision.userId,
      workspaceId: decision.workspaceId,
      ...(projectId ? { projectId } : {}),
      title,
      goal: title,
    });
    if (res.status !== "created" && res.status !== "deduped") {
      logger.error(
        { decisionId: decision.id, status: res.status },
        "proposed decision: the home session could not be created — nobody was asked"
      );
      return null;
    }
    homeId = res.session.id;
  }

  let before: ExpectedOutput[] = [];
  let after: ExpectedOutput[] = [];
  let wrote = false;
  await updateExpectedOutputsLocked(homeId, (current) => {
    // Re-checked under the lock: a concurrent emit may have just added it.
    if (current.some((o) => isOpenDecisionAsk(o, decision.id))) return null;
    const taken = new Set(
      current.map((o) => normalizeExpectedLabel(o?.label) ?? "")
    );
    before = current;
    // A slot that already carries this decision (answered, retired) is
    // re-asked IN PLACE rather than duplicated.
    const prior = current.findIndex((o) => o?.decisionId === decision.id);
    const fresh = decisionSlot(decision, taken);
    after =
      prior >= 0
        ? current.map((o, i) => {
            if (i !== prior) return o;
            const {
              retiredAt: _r,
              retiredReason: _rr,
              answerPickedUpAt: _p,
              ...rest
            } = o;
            const history = [
              ...(rest.answerHistory ?? []),
              ...(rest.answer ? [rest.answer] : []),
            ];
            const { answer: _a, ...kept } = rest;
            return {
              ...kept,
              ...(history.length ? { answerHistory: history.slice(-10) } : {}),
              owner: "human" as const,
              blockedReason: "decision" as const,
              why: fresh.why,
              ask: fresh.ask,
              owedSince: fresh.owedSince,
            };
          })
        : [...current, fresh];
    wrote = true;
    return after;
  });
  if (wrote) {
    await logSlotsAsked({
      userId: decision.userId,
      sessionId: homeId,
      before,
      after,
      agentUserId: null,
    });
    const { notifySessionNeedsYou } =
      await import("../focus-sessions/notify-needs-you.js");
    await notifySessionNeedsYou({
      sessionId: homeId,
      // An agent proposing a decision is handing the person a question; the
      // person filing their own open decision is not news.
      byAgent: decision.createdByKind === "ai_agent",
      reason: { kind: "slots", before, after },
    });
  }
  return { sessionId: homeId, created: wrote };
}

/** The decision was resolved elsewhere: retire every slot still asking it. */
export async function resolveDecisionAsks(
  decision: DecisionRow
): Promise<number> {
  let retired = 0;
  for (const s of await sessionsCarrying(decision)) {
    const ok = await updateExpectedOutputsLocked(s.id, (current) =>
      retireResolvedDecisionAsks(current, decision.id)
    );
    if (ok) retired += 1;
  }
  return retired;
}

export const decisionAskReactor: Reactor = {
  id: "decision-ask",
  match: (payload) =>
    payload.subjectType === "entity" &&
    (payload.action === "create" || payload.action === "update") &&
    // Cheap filter when the door named the kind; a door that did not is
    // checked on the row.
    (payload.data?.profileSlug === undefined ||
      payload.data?.profileSlug === DECISION_PROFILE_SLUG),
  async handler(payload) {
    try {
      const decision = await loadDecision(payload.subjectId);
      if (!decision) return;
      if (decision.properties.decisionStatus === "proposed") {
        await ensureDecisionAsk(decision, payload.sessionId ?? null);
      } else {
        await resolveDecisionAsks(decision);
      }
    } catch (err) {
      logger.error(
        { err, entityId: payload.subjectId, action: payload.action },
        "decision-ask reactor FAILED — a proposed decision may not have been asked, or a resolved one may still be asked"
      );
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerDecisionAskReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(decisionAskReactor);
  logger.info("Registered decision-ask reactor");
}
