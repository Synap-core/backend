/**
 * `@synap-core/types/onboarding/start` — the ONE start model (onboarding A3).
 *
 * Pod-admin, browser and relay all read the same step ids, the same order and
 * the same done-ness rule from here. Pure: no I/O, no database. The server
 * gathers the FACTS (proposal rows, agent roster, journey status) and this
 * file decides. Done-ness is DERIVED from facts, never trusted from
 * `values.start`: a stored pointer says what the person chose, not what
 * happened.
 */

// ── Steps ───────────────────────────────────────────────────────────────────

export const START_STEP_IDS = [
  "start:intent",
  "start:views",
  "start:path",
  "start:setup",
  "start:agent",
  "start:first-work",
  "start:done",
] as const;
export type StartStepId = (typeof START_STEP_IDS)[number];

// ── Values: what the person chose (pointers and choices only) ──────────────

export interface StartValues {
  v: 1;
  intent?: { slug: string; source: "cloud" | "here"; at: string };
  view?: { profile: string; view: string; type: string; at: string };
  path?: { kind: "quick" | "cobuild"; at: string };
  setup?: { proposalId: string; at: string };
  agent?: { agentUserId: string; at: string };
  firstSession?: { sessionId: string; at: string };
  nextReturn?: { at: string; sessionId: string } | null;
}

// ── Facts: what the server observed ────────────────────────────────────────

export type StartAgentConnection = "none" | "pending" | "seen";

export interface StartFacts {
  /** `journey.progress.values.start`, or null when absent. */
  values: StartValues | null;
  /** How many views the chosen start declares (S2 is skipped below 2). */
  startViewCount: number | null;
  /** The row of `values.start.setup.proposalId`, read from the pod. */
  setupProposal: {
    status: "pending" | "approved" | "rejected" | "expired" | string;
    /** Created spaces that are NOT archived. */
    activeSpaceCount: number;
    approvedAt: string | null;
  } | null;
  /** `resolveAgentConnection(roster).kind` (the desktop day-one rule). */
  agentConnection: StartAgentConnection;
  /** Latest reviewed, approved proposal by an external agent the viewer operates. */
  externalAgentApprovalReviewedAt: string | null;
  journeyStatus:
    "offered" | "active" | "completed" | "dismissed" | string | null;
}

export interface StartStepState {
  id: StartStepId;
  done: boolean;
}

const isAfter = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return false;
  const [ta, tb] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
};

/** The §2.2 table. One rule per step; each reads facts, never a stored "done". */
const DONE_RULES: Record<StartStepId, (f: StartFacts) => boolean> = {
  "start:intent": (f) => !!f.values?.intent,
  "start:views": (f) =>
    !!f.values?.view || (f.startViewCount !== null && f.startViewCount < 2),
  "start:path": (f) => !!f.values?.path,
  "start:setup": (f) =>
    !!f.values?.setup?.proposalId &&
    f.setupProposal?.status === "approved" &&
    f.setupProposal.activeSpaceCount >= 1,
  "start:agent": (f) => f.agentConnection === "seen",
  "start:first-work": (f) =>
    isAfter(
      f.externalAgentApprovalReviewedAt,
      f.setupProposal?.approvedAt ?? null
    ),
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
