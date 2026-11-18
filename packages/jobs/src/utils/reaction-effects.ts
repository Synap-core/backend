/**
 * THE EFFECTS a reaction applies: one per `ReactionDo` key, each planning its
 * writes (read only) and applying ONE write through the target's OWN door —
 * never a raw UPDATE (tripwire `reactions-apply-through-doors`). The worker
 * (`workers/reactions.ts`) runs the guards between the plan and the apply.
 *
 * An effect whose door lives in @synap/api (the done door of an outcome) is
 * registered at boot by apps/api (`registerReactionEffect`), the pattern of
 * `registerHoldResumeFollowUp`. Unfilled, the worker skips its writes with
 * `effect_unavailable`, logged: fail-closed, never a guess.
 */
import {
  HoldRefusedError,
  db,
  eq,
  focusSessions,
  setSessionStatus,
} from "@synap/database";
import { dispatchLifecycleTransition } from "@synap/events";
import {
  deliverableOwedBy,
  deriveSlotKeys,
  newestOwedFirst,
  type SlotFacts,
} from "@synap-core/types/units";
import {
  holdWaitMovesRef,
  type AnyTransitionPayload,
  type Hold,
  type TransitionCause,
} from "@synap-core/types/lifecycle";
import type {
  PlannedWrite,
  ReactionDeclaration,
  ReactionEffectKey,
} from "./reactions.js";

/** What applying (or proposing) one write did. */
export type ReactionEffectOutcome =
  | { status: "applied"; transitionIds: string[] }
  | { status: "proposed"; proposalId: string }
  /** Already where the write would put it: nothing to do, nothing logged. */
  | { status: "unchanged" }
  /** The compare-and-set found another status: a person's move wins. */
  | { status: "moved_meanwhile"; detail: string }
  /** The target's door refused it; `detail` is the door's own message. */
  | { status: "refused"; detail: string };

export interface ReactionEffectContext {
  transition: AnyTransitionPayload;
  reaction: ReactionDeclaration;
  cause: TransitionCause;
}

export interface ReactionEffect {
  key: ReactionEffectKey;
  /** The writes this move asks for, read only. Empty: nothing to do. */
  plan(
    transition: AnyTransitionPayload,
    reaction: ReactionDeclaration
  ): Promise<PlannedWrite[]>;
  /** Apply ONE write through the target's door, compare-and-set from `expectedFrom`. */
  apply(
    write: PlannedWrite,
    ctx: ReactionEffectContext
  ): Promise<ReactionEffectOutcome>;
  /**
   * File the write as a proposal (D3: a move into done or lost). Absent: such
   * a write is skipped `needs_proposal`, never applied.
   */
  propose?(
    write: PlannedWrite,
    ctx: ReactionEffectContext
  ): Promise<ReactionEffectOutcome>;
}

const effects = new Map<ReactionEffectKey, ReactionEffect>();

/** Fill an effect's slot (apps/api at boot for the api-side doors). */
export function registerReactionEffect(effect: ReactionEffect): void {
  effects.set(effect.key, effect);
}

export function reactionEffectOf(
  key: ReactionEffectKey
): ReactionEffect | null {
  return effects.get(key) ?? null;
}

/** Tests only. */
export function resetReactionEffectsForTests(): void {
  effects.clear();
  registerReactionEffect(pauseSessionEffect);
}

// ── pause_session: default 4, "a run that stops early goes to Needs you" ──

type StoredSlot = SlotFacts & {
  key?: string | null;
  label?: string | null;
  owedSince?: string | null;
};

/**
 * The slot the session now waits on the person for: the newest one it owes
 * them (the run's "Continue at <stage>?" ask, a stage-end ask, a question).
 * Pure. Null when it owes them nothing: then nobody waits on the person.
 */
export function slotTheRunWaitsOn(
  slots: readonly StoredSlot[]
): { key: string; label: string } | null {
  const keys = deriveSlotKeys(slots);
  const [newest] = slots
    .map((slot, at) => ({ slot, key: keys[at] }))
    .filter(({ slot, key }) => key && slot && deliverableOwedBy(slot) === "you")
    .sort((a, b) => newestOwedFirst(a.slot, b.slot));
  return newest
    ? { key: newest.key!, label: newest.slot.label || newest.key! }
    : null;
}

/**
 * Run → `waiting_on_you` ⇒ its session pauses, held on the person until they
 * answer the slot the run waits on (`answer:<session>/<slot>`): the session
 * then reads "waits on you", and the hold-resume reactor resumes it once the
 * answer lands (`waitHoldsMet`). The ask itself is already in Needs you (an
 * owed slot, `raiseRunAsk`); this adds the session's own state.
 */
export const pauseSessionEffect: ReactionEffect = {
  key: "pause_session",
  async plan(t) {
    if (t.subjectType !== "playbook_run" || !t.sessionId) return [];
    const [s] = await db
      .select({
        id: focusSessions.id,
        status: focusSessions.status,
        userId: focusSessions.userId,
        title: focusSessions.title,
        goal: focusSessions.goal,
        expectedOutputs: focusSessions.expectedOutputs,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, t.sessionId))
      .limit(1);
    // Only a session at work is paused: one already paused (a gate, another
    // hold), ended or not started is left where it stands.
    if (!s || s.status !== "active") return [];
    const slot = slotTheRunWaitsOn(
      Array.isArray(s.expectedOutputs) ? s.expectedOutputs : []
    );
    if (!slot) return [];
    const name = s.title || s.goal;
    const hold: Hold = {
      on: "person",
      reason: `The run stopped and waits on you: ${slot.label}.`,
      until: {
        moves: holdWaitMovesRef({
          kind: "answer",
          sessionId: s.id,
          slot: slot.key,
        }),
      },
    };
    return [
      {
        target: { subjectType: "focus_session", subjectId: s.id },
        to: "paused",
        toCategory: "paused",
        expectedFrom: s.status,
        ownerUserId: s.userId,
        detail: { slotKey: slot.key, hold },
        say: {
          name,
          applied: `Paused \u201c${name}\u201d: its run stopped and waits on your answer to \u201c${slot.label}\u201d.`,
        },
      },
    ];
  },
  async apply(write, ctx) {
    try {
      const { rows, transitions } = await setSessionStatus(db, {
        sessionId: write.target.subjectId,
        from: write.expectedFrom as "active",
        to: "paused",
        actor: { kind: "system" },
        reason: (write.detail.hold as Hold).reason ?? null,
        hold: write.detail.hold as Hold,
        cause: ctx.cause,
      });
      if (rows.length === 0) {
        return {
          status: "moved_meanwhile",
          detail: `focus_session no longer ${write.expectedFrom}`,
        };
      }
      for (const t of transitions) {
        await dispatchLifecycleTransition(t.transitionId);
      }
      return transitions.length > 0
        ? {
            status: "applied",
            transitionIds: transitions.map((t) => t.transitionId),
          }
        : { status: "unchanged" };
    } catch (err) {
      if (err instanceof HoldRefusedError) {
        return { status: "refused", detail: err.message };
      }
      throw err;
    }
  },
};

registerReactionEffect(pauseSessionEffect);
