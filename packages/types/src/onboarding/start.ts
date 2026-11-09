/**
 * `@synap-core/types/onboarding/start` — the ONE start model (onboarding A3).
 *
 * Pod admin reads the step ids, their order and the done-ness rule from
 * here; the pod derives them the same way. Pure: no I/O, no database. The server
 * gathers the FACTS (proposal rows, agent roster, journey status) and this
 * file decides. Done-ness is DERIVED from facts, never trusted from
 * `values.start`: a stored pointer says what the person chose, not what
 * happened.
 */

import { PRESENCE_ENFORCE_MIN_WAYS } from "../presence/index.js";

// ── Steps ───────────────────────────────────────────────────────────────────

export const START_STEP_IDS = [
  "start:intent",
  // Two ways to confirm it's you, before anything else is set (founder,
  // 7 Nov 2026, session 539e519b): a pod starts in `enforce`, and an owner
  // with one way in is locked out the day it fails (finding 7bf25c2e). Done
  // once the owner holds two ways in, or went past it ("Skip for now"; the
  // top bar keeps saying so until they do).
  "start:access",
  // The pod's notable defaults, shown once as switches the owner may change
  // (founder, 5 Nov 2026, session b064a220).
  "start:defaults",
  // Pod admin's onboarding ends here (founder, 7 Nov 2026, session
  // 539e519b): the work itself (views, a first space, an agent, the first
  // session) is the desktop's and Relay's, never a pod admin page.
  "start:done",
] as const;
export type StartStepId = (typeof START_STEP_IDS)[number];

// ── Values: what the person chose (pointers and choices only) ──────────────

export interface StartValues {
  v: 1;
  intent?: { slug: string; source: "cloud" | "here"; at: string };
  /**
   * The owner went past the defaults step (Continue). The switches
   * themselves are written by each setting's own door, never here.
   */
  defaults?: { at: string };
  /**
   * The owner went past the secure-access step (Continue, or "Skip for now"
   * with fewer than two ways in). The ways themselves are added through each
   * factor's own door (passkeys, the authenticator app, recovery codes).
   */
  access?: { at: string };
  /*
   * The fields below are no longer steps of pod admin's journey (7 Nov
   * 2026). They stay readable: stored journeys carry them, and the first
   * session door (`services/focus-sessions/first-session.ts`) reads `setup`
   * and writes `firstSession`.
   */
  view?: { profile: string; view: string; type: string; at: string };
  path?: { kind: "quick" | "cobuild"; at: string };
  setup?: { proposalId: string; at: string };
  agent?: { agentUserId: string; at: string };
  firstSession?: { sessionId: string; at: string };
  nextReturn?: { at: string; sessionId: string } | null;
}

// ── Facts: what the server observed ────────────────────────────────────────

export interface StartFacts {
  /** `journey.progress.values.start`, or null when absent. */
  values: StartValues | null;
  /**
   * The owner's ways to confirm it's them (`presenceWaysIn`), or null when
   * the pod could not count them: a failed read never marks the step done.
   */
  waysIn: number | null;
  journeyStatus:
    "offered" | "active" | "completed" | "dismissed" | string | null;
}

export interface StartStepState {
  id: StartStepId;
  done: boolean;
}

/** The §2.2 table. One rule per step; each reads facts, never a stored "done". */
const DONE_RULES: Record<StartStepId, (f: StartFacts) => boolean> = {
  "start:intent": (f) => !!f.values?.intent,
  "start:access": (f) =>
    !!f.values?.access ||
    (f.waysIn !== null && f.waysIn >= PRESENCE_ENFORCE_MIN_WAYS),
  "start:defaults": (f) => !!f.values?.defaults,
  "start:done": (f) => f.journeyStatus === "completed",
};

export function deriveStartSteps(facts: StartFacts): StartStepState[] {
  return START_STEP_IDS.map((id) => ({ id, done: DONE_RULES[id](facts) }));
}

/** The first step not done, or null when every step is. */
export function nextStartStep(steps: StartStepState[]): StartStepId | null {
  return steps.find((s) => !s.done)?.id ?? null;
}

/**
 * The ids `completedActionIds` carries: the model's PREFIX before the next
 * step (a patch replaces the stored list, so the server writes this whole).
 */
export function completedStartPrefix(steps: StartStepState[]): StartStepId[] {
  const out: StartStepId[] = [];
  for (const s of steps) {
    if (!s.done) break;
    out.push(s.id);
  }
  return out;
}

// ── View resolution (§2.3) ─────────────────────────────────────────────────

export interface KindViewPref {
  view: string;
  type: string;
  at: string;
  source: "onboarding" | "settings";
}

export interface TemplateView {
  slug: string;
  type: string;
}

export interface ResolvedKindView {
  view: string;
  type: string;
  from: "pref" | "space-default" | "template-first";
}

/**
 * The one read rule: the person's pref, then the space's default, then the
 * template's first. A pref or default naming a view the template no longer
 * has falls through rather than resolving to a view that cannot render.
 */
export function resolveKindView(input: {
  pref: KindViewPref | null | undefined;
  templateViews: TemplateView[];
  spaceDefault: string | null | undefined;
}): ResolvedKindView | null {
  const { pref, templateViews, spaceDefault } = input;
  const find = (slug: string | null | undefined) =>
    slug ? templateViews.find((v) => v.slug === slug) : undefined;

  const p = find(pref?.view);
  if (p) return { view: p.slug, type: p.type, from: "pref" };
  const d = find(spaceDefault);
  if (d) return { view: d.slug, type: d.type, from: "space-default" };
  const first = templateViews[0];
  return first
    ? { view: first.slug, type: first.type, from: "template-first" }
    : null;
}

// ── The first prompt (§2.5) ────────────────────────────────────────────────

export function buildGetStartedPrompt(input: {
  sessionTitle: string;
  sessionId: string;
}): string {
  return `Use Synap. Get started with Synap: open my session "${input.sessionTitle}" (${input.sessionId.slice(0, 8)}) and do its first step. Ask me before you keep anything.`;
}
