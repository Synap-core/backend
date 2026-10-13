/**
 * `@synap-core/types/lifecycle` — the ONE lifecycle model the surfaces read
 * (work model L1/L2, W12–W14).
 *
 * A kind or a role declares at most one lifecycle: a select property whose
 * options carry a FIXED category (`open · active · paused · done · lost`).
 * Surfaces read the category for anything structural (terminal, column
 * grouping, tone) and never guess from an option's name.
 *
 * The pod keeps its own copy of the category list and option shape
 * (`@synap/database` `utils/lifecycle-model.ts`, it cannot import this
 * package); `./pod-parity.contract.ts` pins the two EQUAL at compile time.
 */
import type { LifecycleCategory, LifecycleOption } from "./option.js";

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
 * The payload of `entity.transition.completed` — the ONE event every status
 * move emits (the `moveStatus` door). `role` is the role-profile slug when the
 * status is a role's (stored on the facet), null for the kind's own lifecycle.
 */
export interface LifecycleTransitionPayload {
  transitionId: string;
  entityId: string;
  profileSlug: string | null;
  role: string | null;
  facetId: string | null;
  property: string;
  from: string | null;
  to: string;
  fromCategory: LifecycleCategory | null;
  category: LifecycleCategory;
  actorKind: "human" | "agent" | "system";
  userId: string;
  agentUserId: string | null;
  sessionId: string | null;
  reason: string | null;
  /** A person moved it from a value they had not seen ("moved meanwhile"). */
  staleExpected: boolean;
  proposalId: string | null;
}

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
