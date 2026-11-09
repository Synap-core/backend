/**
 * A THING'S BLOCKER (plan e7f753db §9, "blockers, not steps"): what stands
 * between a thing and its next status, read from the waits THE collector
 * already finds (`readWaitingOnSourcesFor`, api `status-facts.ts`) — never a
 * second read and never a new status. A blocked thing stays in its column;
 * its card says why, whose move it is, what clears it and what it unlocks.
 *
 * Beside {@link deriveWaitingOn} (`./goal.ts`), which folds the same sources
 * into a goal's or a session's "Waiting on" marks. Pure.
 *
 * THE RULE: blockers are an OVERLAY. A hold (a paused status, `hold` source)
 * is a deliberate park that moves the column, so it never blocks here: the
 * two stay separate or the model forks. Every other source that makes a
 * waiting-on mark blocks: a person's owed slot, an agent's slot that declares
 * the thing it blocks, a proposal on the thing, a `blocked_by` edge, a step
 * that declares a wait, a step requirement the thing does not meet, an open
 * PR, an open sub-session.
 */
import {
  lifecycleOptionLabel,
  type LifecycleOption,
} from "../lifecycle/option.js";
import { nextMainPathStep } from "../lifecycle/steps.js";
import {
  waitingOnReasonOf,
  waitKindOf,
  type WaitingOnReason,
  type WaitingOnRef,
  type WaitingOnSource,
} from "./goal.js";
import {
  WAIT_BALLS,
  WAIT_KIND_BALL,
  type WaitBall,
  type WaitKind,
} from "./wait-kind.js";

/**
 * The thing a slot holds up and the status it cannot reach yet — the
 * structural mirror of `SlotBlocks` (`@synap/playbooks`, which this package
 * cannot import; held to it by a compile-time parity check in the api).
 */
export interface ThingBlockerBlocks {
  entityId?: string;
  to?: string;
}

/** What clears a blocker — the mirror of `SlotClearedBy` (`@synap/playbooks`). */
export type ThingBlockerClearedBy =
  | { answer: true }
  | { intent: string }
  | { playbookId: string }
  | { capability: string };

/** Why a thing is blocked: the lead wait, in the pod's own vocabulary. */
export interface ThingBlockerWhy {
  /** The coarse waiting-on reason (`WAITING_ON_REASONS`). */
  reason: WaitingOnReason;
  /** The finer wait kind (`WAIT_KINDS`); its ball is {@link ThingBlocker.ball}. */
  waitKind: WaitKind;
  /** An owed slot's class of blocker ("what to build"), else null. */
  blockedReason: string | null;
  /**
   * The lead wait's stable name: an owed slot's declared domain name
   * (`not_connected`), a pending proposal's type (`messaging.external.send`)
   * a held send's reason (`not_connected`) or a step requirement's declared
   * name (`no_contact`); else null.
   */
  blockerKey: string | null;
}

export interface ThingBlocker {
  blocked: boolean;
  /** How many waits block it (the lead one is described below). */
  count: number;
  why: ThingBlockerWhy | null;
  /** Whose move it is: the lead wait's ball (yours first). */
  ball: WaitBall | null;
  /**
   * The status clearing it lets the thing reach: the lead slot's declared
   * `blocks.to` when its lifecycle declares it, else the next main-path
   * status. Null when the thing has no lifecycle, stands off its path, or
   * has no step left.
   */
  unlocks: { to: string; label: string } | null;
  /**
   * What clears it: the lead slot's declared door; a person's owed slot with
   * none is cleared by their answer. Null when nothing names one (a proposal
   * is cleared by its review, a `blocked_by` by the other work).
   */
  clearedBy: ThingBlockerClearedBy | null;
  /** What is waited on (the lead wait's ref), when the reader may read it. */
  ref: WaitingOnRef | null;
}

const NOT_BLOCKED: ThingBlocker = {
  blocked: false,
  count: 0,
  why: null,
  ball: null,
  unlocks: null,
  clearedBy: null,
  ref: null,
};

/** Does this wait block the thing (the overlay rule above)? */
export function isThingBlockingSource(source: WaitingOnSource): boolean {
  return source.kind !== "hold" && waitingOnReasonOf(source) !== null;
}

function ballRank(source: WaitingOnSource): number {
  return WAIT_BALLS.indexOf(WAIT_KIND_BALL[waitKindOf(source)]);
}

/**
 * THE status a blocker stands between a thing and — what clearing it lets
 * the thing reach: the declared `to` when its lifecycle declares it (and it
 * is not where the thing already stands), else the next main-path status
 * (`nextMainPathStep`). Null without a lifecycle, off its path or with no
 * step left. ONE rule for the board's card (`deriveThingBlocker`) and the
 * need-you card's "status after" (api `blocked-things.ts`).
 */
export function thingBlockerUnlocks(
  lifecycle: { readonly options: readonly LifecycleOption[] } | null,
  status: string | null,
  declaredTo?: string | null
): { to: string; label: string } | null {
  if (!lifecycle) return null;
  const declared = declaredTo?.trim();
  if (declared) {
    // The declared lifecycle is the authority: a `to` it does not declare
    // falls back to the next step rather than naming a status that does not
    // exist (a card would offer a column no board draws).
    const option = lifecycle.options.find((o) => o.key === declared);
    if (option && declared !== status) {
      return { to: option.key, label: lifecycleOptionLabel(option) };
    }
  }
  const step = nextMainPathStep(lifecycle, status);
  return step.found && step.next
    ? { to: step.next.key, label: step.next.label }
    : null;
}

function clearedByOf(lead: WaitingOnSource): ThingBlockerClearedBy | null {
  if (lead.kind === "requirement") return lead.clearedBy ?? null;
  if (lead.kind !== "owed_slot") return null;
  if (lead.clearedBy) return lead.clearedBy;
  return lead.owner === "agent" ? null : { answer: true };
}

/**
 * THE derivation. `sources` are one thing's waits (THE collector's), its
 * `lifecycle` the declared one it moves on (null without one) and `status`
 * the status it stands on. The lead wait is the one whose ball comes first
 * (yours, theirs, an agent's, a machine's, other work, a date), in source
 * order within a ball — the order every screen sorts by (`leadWaitKind`).
 */
export function deriveThingBlocker(
  sources: readonly WaitingOnSource[],
  lifecycle: { readonly options: readonly LifecycleOption[] } | null,
  status: string | null
): ThingBlocker {
  const blocking = sources.filter(isThingBlockingSource);
  if (blocking.length === 0) return NOT_BLOCKED;
  let lead = blocking[0]!;
  for (const s of blocking) {
    if (ballRank(s) < ballRank(lead)) lead = s;
  }
  const waitKind = waitKindOf(lead);
  return {
    blocked: true,
    count: blocking.length,
    why: {
      // Non-null: `isThingBlockingSource` kept only sources that make a mark.
      reason: waitingOnReasonOf(lead)!,
      waitKind,
      blockedReason:
        lead.kind === "owed_slot" ? (lead.blockedReason ?? null) : null,
      blockerKey:
        lead.kind === "owed_slot" ||
        lead.kind === "pending_proposal" ||
        lead.kind === "requirement"
          ? (lead.blockerKey ?? null)
          : null,
    },
    ball: WAIT_KIND_BALL[waitKind],
    unlocks: thingBlockerUnlocks(
      lifecycle,
      status,
      lead.kind === "owed_slot" ? lead.blocks?.to : null
    ),
    clearedBy: clearedByOf(lead),
    ref: lead.ref ?? null,
  };
}
