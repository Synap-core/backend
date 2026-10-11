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
import type { UnitTone } from "../units/state.js";
import { resolveStatusLabel } from "../vocabulary/index.js";

export const LIFECYCLE_CATEGORIES = [
  "open",
  "active",
  "paused",
  "done",
  "lost",
] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

export const TERMINAL_LIFECYCLE_CATEGORIES: readonly LifecycleCategory[] = [
  "done",
  "lost",
];

export interface LifecycleOption {
  key: string;
  /** Authored label. Absent ⇒ the vocabulary (`resolveStatusLabel`). */
  label?: string;
  category: LifecycleCategory;
  /** A `UnitTone` token. Absent ⇒ {@link LIFECYCLE_CATEGORY_TONE}. */
  tone?: string;
  humanOnly?: boolean;
}

export interface LifecycleDeclaration {
  propertySlug: string;
  options: LifecycleOption[];
}

/** The default mark of each category — a tone TOKEN, never a colour. */
export const LIFECYCLE_CATEGORY_TONE: Readonly<
  Record<LifecycleCategory, UnitTone>
> = {
  open: "textSecondary",
  active: "primary",
  paused: "warning",
  done: "success",
  lost: "error",
};

const UNIT_TONES: readonly string[] = [
  "primary",
  "ai",
  "info",
  "error",
  "success",
  "warning",
  "textSecondary",
  "textMuted",
] satisfies readonly UnitTone[];

export function isTerminalLifecycleCategory(
  category: LifecycleCategory | null | undefined
): boolean {
  return category != null && TERMINAL_LIFECYCLE_CATEGORIES.includes(category);
}

/** The words for an option: its authored label, else the shared vocabulary. */
export function lifecycleOptionLabel(
  option: Pick<LifecycleOption, "key" | "label">
): string {
  return option.label?.trim() || resolveStatusLabel(option.key);
}

/** The tone for an option: its authored tone (if a real token), else its category's. */
export function lifecycleOptionTone(
  option: Pick<LifecycleOption, "category" | "tone">
): UnitTone {
  return option.tone && UNIT_TONES.includes(option.tone)
    ? (option.tone as UnitTone)
    : LIFECYCLE_CATEGORY_TONE[option.category];
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
