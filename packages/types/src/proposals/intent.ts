/**
 * PROPOSAL INTENT & IMPACT — one classifier, every review surface.
 *
 * A reviewer opening the queue asks three questions before reading a word:
 * *what does this DO*, *how much does it cost me if I'm wrong*, and *can I
 * decide it without opening it*. Relay, the browser governance feed and
 * synap-app each answered those locally, so the same proposal could read
 * "Writes / neutral" on one surface and be swipe-approvable on another.
 *
 * This module is PURE and dependency-free — no React, no object-registry, no
 * governance engine — so Relay (React Native / Hermes), Electron, Next.js, the
 * CLI and the pod all import the same answer. It is published as its own LEAF
 * subpath (`@synap-core/types/proposals/intent`) rather than through the
 * `./proposals` barrel, because the barrel re-exports `@synap/database` types
 * and a VALUE import from a barrel is what crashes Hermes.
 *
 * ── It derives from fields ALREADY ON THE WIRE ──────────────────────────────
 * `kind` (the frontend `ProposalKind` union), `class` (`proposalClassFields`,
 * stamped by every read door), `governanceReason` (the engine's reason CODE,
 * not its sentence) and `revertable` (the backend's own revert-planner answer).
 * No new field, therefore no api-types regen, therefore nothing to backfill.
 *
 * ── State is a MARK ────────────────────────────────────────────────────────
 * `tone` is a palette token NAME from `UnitTone` (`../units/state.js`) and
 * never a colour; `glyph` is a lucide icon NAME that exists in BOTH
 * `lucide-react` and `lucide-react-native`. Nothing here returns a sentence —
 * user-facing words come from `@synap-core/types/vocabulary`.
 *
 * ── SEVERITY and IMPACT answer DIFFERENT questions, and may disagree ───────
 * `resolveProposalSeverity` is BLAST RADIUS — what class of thing this touches
 * (ordinary / destructive / admin). `resolveProposalImpact` is COST OF BEING
 * WRONG — how much a mistaken approval costs (routine / notable / high).
 *
 * They are not two spellings of one scale, so a proposal can legitimately be
 * `severity: "ordinary"` and `impact: "high"` at once — a capability INSTALL is
 * exactly that: it removes nothing and changes nobody's rights (ordinary blast
 * radius), but it grafts structure and credentials onto the pod that are
 * tedious to unpick (high cost of being wrong). A reader who expects the two to
 * track each other will read the phone's emphasis and the workbench's calm grey
 * as a bug; they are the same row answering two questions. Pinned by the
 * disagreement fixtures in `intent.test.ts` so neither can drift into the other.
 *
 * ── The ochre gap, stated rather than invented ─────────────────────────────
 * `UnitTone` has no ochre/warning token, but the blast-radius bucket
 * vocabulary does (`Scope & access`). So `governance` and `access` are toned
 * `error` here — the strongest token that exists — and the admin-vs-removal
 * distinction is carried by `glyph` (`shield` / `key` vs `trash`) and by
 * `resolveProposalSeverity`, which keeps the four-value floor vocabulary
 * intact. Do NOT add an eighth tone token to satisfy this file; a token must
 * exist on every surface's palette before it exists here.
 */

import type { UnitTone } from "../units/state.js";
import { isNonWidenableGovernanceReason } from "./governance-grant-options.js";

/**
 * WHAT a proposal does, in the reviewer's terms. Deliberately SMALL: nine
 * answers over twenty-two kinds. A tenth member must name a genuinely
 * different question, not a second spelling of an existing one.
 */
export const PROPOSAL_INTENTS = [
  "create",
  "change",
  "remove",
  "install",
  "run",
  "session",
  "plan",
  "governance",
  "access",
] as const;
export type ProposalIntent = (typeof PROPOSAL_INTENTS)[number];

/**
 * How much it costs to be wrong. Three values, because a reviewer triages in
 * three speeds: wave it, read it, think about it.
 */
export type ProposalImpact = "routine" | "notable" | "high";

/**
 * How much room the row deserves. `compact` = a one-line row (a field edit);
 * `emphasis` = the row that must not be skimmed (a removal, an install, an
 * access change); `standard` = everything else.
 */
export type ProposalSilhouette = "standard" | "compact" | "emphasis";

/**
 * The governance floor's four-value severity vocabulary, mirrored here so a
 * pure leaf can classify a proposal by its OWN kind. This is NOT a second
 * verb list: the severity of an arbitrary event KEY is still the server
 * floor's answer (`useActionSeverity`). A proposal knows what it will do.
 */
export type ProposalSeverity = "destructive" | "admin" | "scope" | "ordinary";

/**
 * The MINIMAL structural shape — never the React `ProposalPresentation`. A
 * caller passes what it has; every field but `kind` is optional and every
 * absence fails toward "needs a human", never toward "safe".
 */
export interface ProposalIntentInput {
  /** The frontend `ProposalKind` discriminant, as a plain string. */
  kind: string;
  /** `proposalClassFields().class` — objectWork | curatorial | ephemeral | governance | access. */
  class?: string | null;
  /** The engine's reason CODE (e.g. "DESTRUCTIVE_HARD_FLOOR"), not its sentence. */
  governanceReason?: string | null;
  /** The backend revert planner's answer. `null`/absent is NOT `true`. */
  revertable?: boolean | null;
  /**
   * The proposal's change type (`create` / `update` / `delete` / …). Read for
   * `link` only: a link proposal CREATES or REMOVES a relation, and its mark
   * must say which (`resolveLinkOperation`). Absent on a link is not "create"
   * for the swipe gate — it fails closed.
   */
  changeType?: string | null;
  /** kind === "facet": a detach removes a role, an attach does not. */
  facetAction?: "attach" | "update" | "detach" | null;
  /** kind === "create": a document body has to be READ, so it is not a glance. */
  hasDocument?: boolean | null;
  /** Multi-object graph — true for `composite`, and for anything carrying one. */
  isComposite?: boolean | null;
  /** A connection sync import: its consent is chosen on the review screen. */
  connectionSync?: boolean | null;
}

export interface ProposalIntentView {
  intent: ProposalIntent;
  /** A `UnitTone` token NAME. Never a colour. */
  tone: UnitTone;
  /** A lucide icon NAME, present in both lucide-react and lucide-react-native. */
  glyph: string;
  silhouette: ProposalSilhouette;
}

/**
 * THE kind → intent table. DATA, not a switch, so the coverage guard in
 * `@synap-core/proposal-types` can compare it against the `ProposalKind`
 * union member-for-member and fail the moment a kind is added upstream
 * without an answer here.
 *
 * `composite` is `create`: measured over 166 live composites, every modelled
 * op is a create (780 `create_entity`, 678 `create_relation`, zero
 * skill/automation/rule). Its SCALE, not its verb, is what the reviewer
 * weighs — that is `rollupComposite`'s job, not the intent's.
 *
 * `merge` is `remove`, not `change`: it soft-deletes the loser, and reading as
 * a tidy-up is exactly why it is the easiest destructive op to wave through.
 *
 * There is NO kind that maps to `access` — the union has none. An access
 * decision is recognised by its CLASS (`proposal-class.ts`'s `ACCESS_DOORS`),
 * which is why `class` is an input at all.
 */
export const KIND_INTENT: Readonly<Record<string, ProposalIntent>> = {
  create: "create",
  composite: "create",

  update: "change",
  document: "change",
  facet: "change",

  // The DEFAULT for a link — its change type refines it (`LINK_INTENT`): an
  // unlink is a `remove`, so the header mark agrees with the red ✕ the visual
  // draws. Kept in this table so the kind-coverage guard still sees `link`.
  link: "create",

  delete: "remove",
  merge: "remove",
  cleanup_pack: "remove",

  install: "install",

  capability_run: "run",
  automation_run: "run",

  session: "session",

  dev_plan_approval: "plan",
  dev_deploy_approval: "plan",

  governance_widen: "governance",
  governance_tighten: "governance",
  governance_raise_ceiling: "governance",
  governance_raise_proposal_cap: "governance",
  governance_tighten_posture: "governance",
  governance_structure_guideline: "governance",
  governance_work_guideline: "governance",
};

/**
 * Intent → mark. Tone is CONSEQUENCE, in four steps over the seven available
 * tokens: `success` adds something new, `info` modifies something that exists,
 * `primary` authorises an action the pod will take outward, `error` removes
 * something or moves the access boundary.
 */
const INTENT_MARK: Readonly<
  Record<ProposalIntent, { tone: UnitTone; glyph: string }>
> = {
  create: { tone: "success", glyph: "plus" },
  change: { tone: "info", glyph: "pencil" },
  remove: { tone: "error", glyph: "trash" },
  install: { tone: "info", glyph: "package" },
  run: { tone: "primary", glyph: "play" },
  session: { tone: "info", glyph: "target" },
  plan: { tone: "info", glyph: "list-checks" },
  governance: { tone: "error", glyph: "shield" },
  access: { tone: "error", glyph: "key" },
};

/** Intents whose row must never be skimmed, regardless of measured impact. */
const EMPHASIS_INTENTS: ReadonlySet<ProposalIntent> = new Set([
  "remove",
  "install",
  "governance",
  "access",
  "plan",
]);

/**
 * Kinds that carry a real side effect beyond the record they name — an
 * outbound call, a running unit of work, a body to read, a package of objects.
 * Not `high` (nothing is destroyed, nothing changes who may act) but never
 * `routine` either.
 */
const NOTABLE_KINDS: ReadonlySet<string> = new Set([
  "capability_run",
  "automation_run",
  "session",
  "document",
  "composite",
  "dev_plan_approval",
  "dev_deploy_approval",
]);

/** `class` values that are an access / policy decision whatever the kind says. */
const HIGH_CLASSES: ReadonlySet<string> = new Set(["governance", "access"]);

export type LinkOperation = "create" | "update" | "remove";

/**
 * THE change-type → link operation rule. One derivation read by the intent
 * mark (below), the link title (`formatLinkTitle`, proposal-types) and the
 * renderer's link visual, so a card can never title a link "Unlink" while its
 * header mark says "create". Absent / unknown reads as `create`: link
 * proposals are create-only unless the payload says otherwise.
 */
export function resolveLinkOperation(
  changeType: string | null | undefined
): LinkOperation {
  if (changeType === "delete" || changeType === "remove") return "remove";
  if (changeType === "update") return "update";
  return "create";
}

const LINK_INTENT: Readonly<Record<LinkOperation, ProposalIntent>> = {
  create: "create",
  update: "change",
  remove: "remove",
};

/** Unknown kinds fall to `change`: the honest "it edits something" answer, and
 *  the one that carries no swipe privilege (see `SWIPE_SAFE_KINDS`). */
export function resolveProposalIntentKind(
  input: ProposalIntentInput
): ProposalIntent {
  const cls = input.class ?? undefined;
  if (cls && HIGH_CLASSES.has(cls)) {
    return cls === "access" ? "access" : "governance";
  }
  if (input.kind === "link") {
    return LINK_INTENT[resolveLinkOperation(input.changeType)];
  }
  return KIND_INTENT[input.kind] ?? "change";
}

export function resolveProposalIntent(
  input: ProposalIntentInput
): ProposalIntentView {
  const intent = resolveProposalIntentKind(input);
  const impact = resolveProposalImpact(input);
  const mark = INTENT_MARK[intent];

  let silhouette: ProposalSilhouette;
  if (impact === "high" || EMPHASIS_INTENTS.has(intent)) {
    silhouette = "emphasis";
  } else if (intent === "change" && impact === "routine") {
    silhouette = "compact";
  } else {
    silhouette = "standard";
  }

  return { intent, tone: mark.tone, glyph: mark.glyph, silhouette };
}

/**
 * How much it costs to be wrong.
 *
 * `high` is the union of four independent claims, each sufficient on its own:
 *   1. the intent removes something, changes who may act, or installs structure;
 *   2. the proposal's CLASS is governance or access;
 *   3. a facet DETACH (a `change`-intent kind that nonetheless removes a role);
 *   4. the engine routed it through a floor NO governance rule can widen
 *      (ADMIN / HUMAN_GATE / ARBITRARY_EXECUTION / AGENT_SCHEMA_DEFINITION /
 *      AGENT_STRUCTURE_WRITE / DESTRUCTIVE_HARD_FLOOR) — the set is owned by
 *      `governance-grant-options.ts` and tripwired against the engine, so this
 *      file never restates it.
 */
export function resolveProposalImpact(
  input: ProposalIntentInput
): ProposalImpact {
  const intent = resolveProposalIntentKind(input);
  if (
    intent === "remove" ||
    intent === "governance" ||
    intent === "access" ||
    intent === "install"
  ) {
    return "high";
  }
  if (input.class && HIGH_CLASSES.has(input.class)) return "high";
  if (input.facetAction === "detach") return "high";
  if (isNonWidenableGovernanceReason(input.governanceReason)) return "high";
  if (NOTABLE_KINDS.has(input.kind) || input.isComposite === true) {
    return "notable";
  }
  return "routine";
}

/**
 * Severity, in the blast-radius bucket vocabulary. The ONE kind → severity
 * derivation; `proposalBlastRadius.ts` consumed a private copy of this switch
 * until it moved here.
 */
export function resolveProposalSeverity(
  input: ProposalIntentInput
): ProposalSeverity {
  if (input.kind === "facet") {
    return input.facetAction === "detach" ? "destructive" : "ordinary";
  }
  const intent = resolveProposalIntentKind(input);
  if (intent === "remove") return "destructive";
  if (intent === "governance" || intent === "access") return "admin";
  return "ordinary";
}

/**
 * Kinds a reviewer may decide from the card alone — update, link, facet, simple
 * create. A link qualifies only with a KNOWN, non-removing change type (see
 * `isSwipeSafe`): an unlink is a removal, and a link whose change type was
 * never passed cannot be told apart from one.
 *
 * THIS LEAF IS THE AUTHORITY. Relay's `swipe-gate.ts` reads it; it does not
 * define a second list. (The comment here used to say it MIRRORED relay while
 * relay's said the leaf was authoritative — a circle in which neither side owned
 * the rule.) Widen it here, or nowhere.
 */
export const SWIPE_SAFE_KINDS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "link",
  "facet",
]);

/**
 * The mark a surface shows when an approval cannot be undone.
 *
 * ONE string, because two surfaces hard-coded their own (relay's `card-marks.ts`
 * and the browser's `GovernanceHistory.tsx`) and a mark that says two different
 * things about the same row is not a mark. It is a MARK, not a sentence: short
 * enough to sit in a chip beside the glyph.
 */
export const IRREVERSIBLE_MARK_LABEL = "Can't be undone";

/**
 * Kinds that are NEVER swipe-safe, listed explicitly rather than left to the
 * allow-list's default. A run has a side effect outside the pod; widening
 * `SWIPE_SAFE_KINDS` one day must not silently make it swipeable. (Same
 * doctrine as relay's explicit `cleanup_pack` case.)
 */
export const NEVER_SWIPE_SAFE_KINDS: ReadonlySet<string> = new Set([
  "capability_run",
  "automation_run",
  "cleanup_pack",
  "composite",
]);

/**
 * Can this be decided with a swipe?
 *
 * FAILS CLOSED on every absence. In particular an ABSENT `governanceReason`
 * does NOT by itself read as safe: the gate additionally requires the kind
 * allow-list and `revertable === true`, so a row whose revertability was never
 * measured (`null`/`undefined`) is opened, not swiped.
 */
export function isSwipeSafe(input: ProposalIntentInput): boolean {
  if (NEVER_SWIPE_SAFE_KINDS.has(input.kind)) return false;
  if (!SWIPE_SAFE_KINDS.has(input.kind)) return false;
  if (input.isComposite === true) return false;
  if (input.connectionSync === true) return false;
  if (input.revertable !== true) return false;
  // An unlink is refused below by its `remove` intent (impact "high"). A link
  // whose change type was never passed cannot be told apart from one, so it
  // fails closed here rather than reading as the create it defaults to.
  if (input.kind === "link" && !input.changeType) return false;
  if (resolveProposalImpact(input) !== "routine") return false;
  // A create carrying a document body is a thing to READ, not to glance at.
  if (input.kind === "create" && input.hasDocument === true) return false;
  return true;
}

export interface CompositeRollup {
  total: number;
  byIntent: Record<ProposalIntent, number>;
  highestImpact: ProposalImpact;
  /** Index into the members array. `-1` for an empty composite. */
  highestImpactMemberIndex: number;
}

const IMPACT_RANK: Record<ProposalImpact, number> = {
  routine: 0,
  notable: 1,
  high: 2,
};

/**
 * Glance model for a plan / graph proposal: "9 items · 7 create · 2 change",
 * plus the worst thing in the package and where it sits — so a UI can float
 * the one member that matters without listing twenty-five rows.
 *
 * A composite is NEVER swipe-safe (`NEVER_SWIPE_SAFE_KINDS`), so no batch
 * affordance can be derived from this.
 */
export function rollupComposite(
  members: readonly ProposalIntentInput[]
): CompositeRollup {
  const byIntent = Object.fromEntries(
    PROPOSAL_INTENTS.map((i) => [i, 0])
  ) as Record<ProposalIntent, number>;

  let highestImpact: ProposalImpact = "routine";
  let highestImpactMemberIndex = members.length > 0 ? 0 : -1;

  members.forEach((m, i) => {
    byIntent[resolveProposalIntentKind(m)] += 1;
    const impact = resolveProposalImpact(m);
    if (IMPACT_RANK[impact] > IMPACT_RANK[highestImpact]) {
      highestImpact = impact;
      highestImpactMemberIndex = i;
    }
  });

  return {
    total: members.length,
    byIntent,
    highestImpact,
    highestImpactMemberIndex,
  };
}
