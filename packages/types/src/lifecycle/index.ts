/**
 * `@synap-core/types/lifecycle` — the ONE lifecycle model the surfaces read
 * (work model L1/L2, W12–W14).
 *
 * A kind or a role declares at most one lifecycle: a select property whose
 * options carry a FIXED category (`open · active · paused · done · lost`).
 * Surfaces read the category for anything structural (terminal, column
 * grouping, tone) and never guess from an option's name.
 *
 * The pod reads these same declarations (`@synap/database`
 * `utils/lifecycle-model.ts` re-exports them); there is no second copy.
 */
import type { LifecycleCategory, LifecycleOption } from "./option.js";
import type { RecordedHold } from "./hold.js";

export {
  LIFECYCLE_CATEGORIES,
  LIFECYCLE_CATEGORY_TONE,
  lifecycleOptionLabel,
  lifecycleOptionTone,
  type LifecycleCategory,
  type LifecycleOption,
} from "./option.js";

export const TERMINAL_LIFECYCLE_CATEGORIES: readonly LifecycleCategory[] = [
  "done",
  "lost",
];

export interface LifecycleDeclaration {
  /** The lifecycle property's slug — the key of the read projection. */
  propertySlug: string;
  options: LifecycleOption[];
}

/**
 * The board column (and status read) holding things no declared option names:
 * NO status at all (never set — the column's `unset` count), or a value no
 * option declares (written before the lifecycle was declared, or left behind
 * by an option rename). Both are "no declared status"; neither is called an
 * undeclared VALUE when it is simply unset (homes X2). Never dropped, never
 * droppable onto. Words:
 * `resolveStatusLabel(UNCLASSIFIED_STATUS)`; why it exists:
 * {@link UNCLASSIFIED_STATUS_HINT}.
 */
export const UNCLASSIFIED_STATUS = "__unclassified";

/** The EXPLAIN line for the unclassified column (both surfaces). */
export const UNCLASSIFIED_STATUS_HINT =
  "No status yet, or a value outside this lifecycle's statuses. Open one to set its status.";

export function isTerminalLifecycleCategory(
  category: LifecycleCategory | null | undefined
): boolean {
  return category != null && TERMINAL_LIFECYCLE_CATEGORIES.includes(category);
}

export function findLifecycleOption(
  decl: Pick<LifecycleDeclaration, "options"> | null | undefined,
  key: string | null | undefined
): LifecycleOption | undefined {
  if (!decl || key == null) return undefined;
  return decl.options.find((o) => o.key === key);
}

/**
 * What a transition is ABOUT. An entity (a kind's lifecycle, or a role's on
 * its facet) moves through the `moveStatus` door; a goal (`project_tracks`)
 * through its own compare-and-set; a focus session through `setSessionStatus`.
 * All three write the SAME shape below, through the same outbox.
 */
export type TransitionSubjectType = "entity" | "track" | "focus_session";

/**
 * ONE TRANSITION SHAPE (status-flow plan W1): what every status move carries,
 * whatever moved. Emitted as `<subjectType>.transition.completed`
 * (`entity.transition.completed`, `track.…`, `focus_session.…`).
 */
export interface TransitionBase {
  transitionId: string;
  subjectType: TransitionSubjectType;
  subjectId: string;
  /** The status property (`status` for a goal or a session). */
  property: string;
  from: string | null;
  to: string;
  fromCategory: LifecycleCategory | null;
  category: LifecycleCategory;
  /** How the move was governed and compare-and-set (who wins a race). */
  actorKind: "human" | "agent" | "system";
  /**
   * Who made it, for attribution: `actorKind`, except a move made with an
   * APP's key (`grants.client_id`, the same attribution `events.app_id`
   * carries, 0310) is the app's: the CRM app moving a deal is neither the
   * person who connected it nor an agent.
   */
  actorClass: TransitionActorClass;
  /** The app's `public_id` when `actorClass` is `app`, else null. */
  appId: string | null;
  /** The person the move is attributed to (the owner of an agent's move). */
  userId: string;
  agentUserId: string | null;
  sessionId: string | null;
  reason: string | null;
  /** A person moved it from a value they had not seen ("moved meanwhile"). */
  staleExpected: boolean;
  proposalId: string | null;
  /** The lens the move happened in. */
  workspaceId: string | null;
  /**
   * When it happened (ISO): now, or up to 30 days back when the mover says so
   * (`resolveOccurredAt`). Time in a status is measured from here.
   */
  occurredAt: string;
  /** When it was recorded (ISO), stamped at the move, never at delivery. */
  recordedAt: string;
  /** `occurredAt` was given and lies before `recordedAt`. */
  backdated: boolean;
  /**
   * What a move into a paused status waits on (`./hold.ts`); null for any
   * other move. The transition log is the hold's only store.
   */
  hold: RecordedHold | null;
}

/** Who made a move, for attribution (`TransitionBase.actorClass`). */
export type TransitionActorClass = "human" | "agent" | "app" | "system";

/**
 * The payload of `entity.transition.completed` — the ONE event every entity
 * status move emits (the `moveStatus` door). `role` is the role-profile slug
 * when the status is a role's (stored on the facet), null for the kind's own
 * lifecycle. `subjectId` is the entity.
 */
export interface LifecycleTransitionPayload extends TransitionBase {
  subjectType: "entity";
  entityId: string;
  profileSlug: string | null;
  role: string | null;
  facetId: string | null;
}

/**
 * The payload of `track.transition.completed` / `focus_session.transition.
 * completed`: a goal's or a session's status moved. `subjectId` is the goal or
 * the session; `projectId` / `trackId` say where it sits (a goal's `trackId`
 * is itself).
 */
export interface WorkUnitTransitionPayload extends TransitionBase {
  subjectType: "track" | "focus_session";
  projectId: string | null;
  trackId: string | null;
}

/** Any transition, discriminated on `subjectType`. */
export type AnyTransitionPayload =
  LifecycleTransitionPayload | WorkUnitTransitionPayload;

export {
  HOLD_DEV_MOVES_HELP,
  HOLD_DEV_TO,
  HOLD_ON,
  HOLD_REQUIRED_MESSAGE,
  HOLD_UNSPECIFIED_BY_AGENT_MESSAGE,
  MOVE_FACTS_IGNORED_NOTICE,
  OCCURRED_AT_NOT_A_MOVE_MESSAGE,
  moveFactsWithoutMoveMessage,
  HOLD_NOT_A_PAUSE_MESSAGE,
  HOLD_REVIEW_DAYS,
  OCCURRED_AT_MAX_PAST_DAYS,
  UNSPECIFIED_HOLD,
  decideMoveHold,
  holdProblem,
  holdDevMovesRef,
  holdWokenBy,
  parseHoldDevRef,
  parseHoldMovesRef,
  recordHold,
  resolveOccurredAt,
  type Hold,
  type HoldDevRef,
  type HoldOn,
  type HoldReviewBase,
  type HoldUntil,
  type MoveHoldDecision,
  type RecordedHold,
} from "./hold.js";

export {
  STATUS_SIGNALS,
  DATE_APPROACHING_DAYS,
  dateDueAt,
  dateSignalOf,
  type StatusSignal,
} from "./signal.js";

export {
  STEP_POSITIONS,
  stepTone,
  stepsFromLifecycle,
  stepsFromTrackStages,
  trackStageStepTone,
  currentStep,
  offPathChoices,
  type StepPosition,
  type StepMark,
  type StepChoice,
} from "./steps.js";

export {
  moveOutcomeOfResult,
  moveOutcomeOfError,
  moveOutcomeMessage,
  moveRequest,
  undoMoveOf,
  type MoveStatusOutcome,
  type MoveStatusSubject,
  type MoveStatusArgs,
  type MoveStatusRequest,
} from "./move.js";

export {
  kindCurrentStatus,
  thingStatusStrips,
  type ThingLifecycle,
  type ThingLifecycleRead,
  type ThingStatusRole,
  type ThingStatusStrip,
} from "./thing.js";
