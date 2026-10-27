/**
 * REVIEW PACKAGES — what a person reviews, grouped by the DECISION it asks
 * (founder decision B-1, 27 Oct 2026: "packages by the decision they ask, in a
 * fixed order", replacing "Needs you = one flat list").
 *
 * A package is not a proposal class (`proposal-class.ts`, which decides how
 * long a proposal stays answerable) and not a needs-you bucket (which decides
 * the order of a page): it is "these items take the same decision", so a
 * reviewer makes one kind of decision at a time instead of five in random
 * order. Eight packages, in a fixed order, by stakes:
 *
 *   questions        an agent waits on an answer (owed slots, asks, stage gates)
 *   access           who may act or see (vault, grants, keys, members, installs)
 *   releases         go or no-go on a deploy (`dev.deploy_approval`)
 *   how-things-work  what agents and the pod follow (skills, rules, playbooks,
 *                    automations, kinds and fields, governance, settings)
 *   data-changes     everything else that writes the person's data
 *   hand-offs        work handed to an agent (`assign_agent`, a playbook run)
 *   knowledge        what agents learned (`import.graph`, `capture.graph`,
 *                    knowledge / decision / research creates)
 *   bookkeeping      an agent's notes on its own session
 *
 * ONE function, {@link reviewPackageOf}, decides it for every surface — the pod
 * stamps it on needs-you rows, pod-admin, browser and relay group by it — so no
 * two surfaces can file the same item under different decisions (B-6).
 *
 * Derived from `proposalType` × `targetType` (plus the record's kind for a
 * create, and the writes of a held-writes pack) — never from agent prose, the
 * same security property as the proposal class: an agent cannot move its item
 * into a quieter package. Bookkeeping is the one package an agent's own write
 * lands in by default, and only for its own session's notes.
 *
 * Coverage: every governed write door (`GOVERNED_WRITE_DOORS`,
 * `@synap/governance-policy`) must be DECIDED here, not reach the fallback —
 * pinned by `review-package-coverage.tripwire.test.ts` in that package, which
 * derives the pairs from the door map rather than a hand list.
 *
 * Pure. Imports only this package's own leaves.
 */

import { isSessionBookkeeping } from "./attention.js";
import { readDeferredWrites } from "./deferred-writes.js";

/** Every package, IN REVIEW ORDER (stakes first). */
export const REVIEW_PACKAGES = [
  "questions",
  "access",
  "releases",
  "how-things-work",
  "data-changes",
  "hand-offs",
  "knowledge",
  "bookkeeping",
] as const;
export type ReviewPackage = (typeof REVIEW_PACKAGES)[number];

/** The fixed order packages are shown in (B-1). Same list, named for its use. */
export const REVIEW_PACKAGE_ORDER: readonly ReviewPackage[] = REVIEW_PACKAGES;

export function isReviewPackage(value: unknown): value is ReviewPackage {
  return (
    typeof value === "string" &&
    (REVIEW_PACKAGES as readonly string[]).includes(value)
  );
}

/** Position in {@link REVIEW_PACKAGE_ORDER} — lower is higher stakes. */
export function reviewPackageRank(pkg: ReviewPackage): number {
  return REVIEW_PACKAGES.indexOf(pkg);
}

// ── Group by ────────────────────────────────────────────────────────────────

/**
 * How a Review page groups (B-4): by package (default), by the work (session
 * first: the joined view of B-5), by the agent that asked, or by time.
 */
export const REVIEW_GROUP_BYS = ["package", "work", "agent", "time"] as const;
export type ReviewGroupBy = (typeof REVIEW_GROUP_BYS)[number];
export const DEFAULT_REVIEW_GROUP_BY: ReviewGroupBy = "package";

export function isReviewGroupBy(value: unknown): value is ReviewGroupBy {
  return (
    typeof value === "string" &&
    (REVIEW_GROUP_BYS as readonly string[]).includes(value)
  );
}

// ── Layouts ─────────────────────────────────────────────────────────────────

/**
 * How one package's items are drawn. `list` exists for every package; the
 * others are the package's own shape (B3 table): ask cards for questions, a
 * document diff for how-things-work, a card gallery for knowledge, one row per
 * agent for hand-offs, one row per session for bookkeeping.
 */
export const REVIEW_LAYOUTS = [
  "list",
  "cards",
  "diff",
  "gallery",
  "by-agent",
  "by-session",
] as const;
export type ReviewLayout = (typeof REVIEW_LAYOUTS)[number];

/**
 * The layouts each package offers, its DEFAULT first. A package with one
 * layout shows no switch.
 */
export const REVIEW_PACKAGE_LAYOUTS: Readonly<
  Record<ReviewPackage, readonly ReviewLayout[]>
> = {
  questions: ["cards", "list"],
  access: ["list"],
  releases: ["list"],
  "how-things-work": ["diff", "list"],
  "data-changes": ["list"],
  "hand-offs": ["by-agent", "list"],
  knowledge: ["gallery", "list"],
  bookkeeping: ["by-session", "list"],
};

export function defaultReviewLayout(pkg: ReviewPackage): ReviewLayout {
  return REVIEW_PACKAGE_LAYOUTS[pkg][0] ?? "list";
}

/**
 * The person's saved review settings (`uiPreferences.review`). `layouts`
 * holds only the packages the person changed.
 */
export interface ReviewPreferences {
  groupBy: ReviewGroupBy;
  layouts?: Partial<Record<ReviewPackage, ReviewLayout>>;
}

/**
 * The layout a package opens in: the saved one when the package offers it,
 * else its default. A saved layout the package no longer offers is ignored,
 * never drawn.
 */
export function reviewLayoutFor(
  pkg: ReviewPackage,
  prefs: Pick<ReviewPreferences, "layouts"> | null | undefined
): ReviewLayout {
  const saved = prefs?.layouts?.[pkg];
  return saved && REVIEW_PACKAGE_LAYOUTS[pkg].includes(saved)
    ? saved
    : defaultReviewLayout(pkg);
}

/** The group-by a page opens in: the saved one, else Package. */
export function reviewGroupByFor(
  prefs: Pick<ReviewPreferences, "groupBy"> | null | undefined
): ReviewGroupBy {
  return isReviewGroupBy(prefs?.groupBy)
    ? prefs.groupBy
    : DEFAULT_REVIEW_GROUP_BY;
}

// ── The classifier ──────────────────────────────────────────────────────────

/** What {@link reviewPackageOf} reads. A needs-you row and a proposal row both fit. */
export interface ReviewPackageInput {
  /**
   * The needs-you signal kind (`proposal-cluster`, `owed-slot`,
   * `access-request` …). Absent, or `proposal-cluster`, for a proposal.
   */
  kind?: string | null;
  proposalType?: string | null;
  targetType?: string | null;
  /** The proposal class the pod stamped (`access` files under Access). */
  class?: string | null;
  /** The record kind a create makes (its profile slug), when known. */
  objectKind?: string | null;
  /**
   * The proposal's stored payload. Read for ONE thing: a held-writes pack's
   * writes (`data.deferredWrites`), which decide its package.
   */
  data?: unknown;
  /**
   * True only when a PERSON filed it. A session write a person proposes is a
   * change to their data, not an agent's bookkeeping. Unknown = an agent's,
   * which is what a pending proposal almost always is.
   */
  filedByPerson?: boolean | null;
}

/** What decided a package — `fallback` means no rule knew the item. */
export type ReviewPackageRule =
  | "signal"
  | "pack"
  | "pair"
  | "class"
  | "type"
  | "bookkeeping"
  | "kind"
  | "target"
  | "fallback";

export interface ReviewPackageDecision {
  package: ReviewPackage;
  rule: ReviewPackageRule;
}

/** Needs-you kinds that are not a proposal: who may act, else something owed. */
const ACCESS_SIGNAL_KINDS: ReadonlySet<string> = new Set([
  "access-request",
  "space-invite",
]);

/**
 * `targetType/proposalType` pairs decided by the PAIR — where neither column
 * alone says the decision. Most are access doors on a target that is
 * otherwise data (`workspace/join` vs `workspace/update`); the rest are runs.
 */
const BY_PAIR: Readonly<Record<string, ReviewPackage>> = {
  // Who may act or see, on a target that is otherwise data. Mirrors the pod's
  // `access` class (`ACCESS_DOORS`, proposal-class.ts); the coverage tripwire
  // fails when a pair the pod classes `access` is not access here.
  "workspace/join": "access",
  "workspace/configure_public_projection": "access",
  "a2ai/join": "access",
  "focus_session/grant_capability": "access",
  "profile/grant_access": "access",
  "profile/change_scope": "access",
  "relation/expose": "access",
  "project/file_entities": "access",
  "agent/connect": "access",
  "agent/updateCapabilities": "access",
  "app/connect": "access",
  "vault/grant": "access",
  // A playbook run hands work to an agent; a capability or command run is an
  // action on the person's data, decided like any other change.
  "playbook/run": "hand-offs",
  "capability/run": "data-changes",
  "command/execute": "data-changes",
  "automation/execute": "data-changes",
  // A capability package being created, attached or wired is behaviour.
  "capability/create": "how-things-work",
  "capability/attach": "how-things-work",
  // Merging two KINDS changes the schema; merging two records is data.
  "profile/merge": "how-things-work",
};

/** Proposal types that decide the package whatever the target. */
const BY_PROPOSAL_TYPE: Readonly<Record<string, ReviewPackage>> = {
  "dev.deploy_approval": "releases",
  // A person's go-ahead the work waits on — a question, answered once.
  "dev.plan_approval": "questions",
  "playbook.stage_gate": "questions",
  assign_agent: "hand-offs",
  "import.graph": "knowledge",
  "capture.graph": "knowledge",
  "vault.request": "access",
  "capability.install": "access",
  "capability.enable": "access",
  "trusted_issuer.widen_scopes": "access",
  "settings.update": "how-things-work",
  "automation.health_advisory": "how-things-work",
  "renderer.set": "how-things-work",
  "capability.run": "data-changes",
  "messaging.external.send": "data-changes",
  cleanup_pack: "data-changes",
  update_pack: "data-changes",
  merge: "data-changes",
  user_edit: "data-changes",
};

/**
 * An agent's notes on a session it works in: its session record, its run, its
 * narrative. Bookkeeping only when an agent filed it ({@link
 * ReviewPackageInput.filedByPerson}). The session-record half is THE
 * bookkeeping rule (`isSessionBookkeeping`, ./attention.ts) minus `create`:
 * a pending session create is a decision there, so it is one here too.
 */
const BOOKKEEPING_PAIRS: ReadonlySet<string> = new Set([
  "playbook_run/update",
  "document/session_narrative_update",
]);

function isBookkeepingWrite(type: string, target: string): boolean {
  if (BOOKKEEPING_PAIRS.has(`${target}/${type}`)) return true;
  return (
    isSessionBookkeeping({
      proposalType: type,
      targetType: target,
      status: null,
    }) && !type.endsWith("create")
  );
}

/** Record kinds whose create is KNOWLEDGE, not a data change. */
export const KNOWLEDGE_OBJECT_KINDS: ReadonlySet<string> = new Set([
  "knowledge",
  "decision",
  "research",
]);

/** Targets whose every write is WHO MAY ACT. */
const ACCESS_TARGETS: ReadonlySet<string> = new Set([
  "workspaceMember",
  "projectMember",
  "role",
  "apiKey",
  "aiProvider",
  "share",
  "trusted_issuer",
  "vault",
]);

/** Targets whose writes change what agents and the pod FOLLOW. */
const HOW_TARGETS: ReadonlySet<string> = new Set([
  "skill",
  "rule",
  "playbook",
  "automation",
  "tool",
  "capability",
  "profile",
  "property_def",
  "relation_def",
  "cell",
  "widget",
  "channel",
  "governance",
  "settings",
]);

/** Targets whose writes are the person's DATA (records, documents, structure). */
const DATA_TARGETS: ReadonlySet<string> = new Set([
  "entity",
  "document",
  "relation",
  "link",
  "facet",
  "artifact",
  "project",
  "track",
  "focus_session",
  "playbook_run",
  "context",
  "library",
  "knowledgeKey",
  "view",
  "bento",
  "whiteboard",
  "workspace",
  "proactive",
  "messaging",
  "pod_hygiene",
  "command",
  "a2ai",
  "agent",
  "app",
]);

/**
 * The package of a held-writes pack (`agent/held_writes`): the
 * HIGHEST-STAKES package among its writes, so one knowledge capture held with
 * 24 session notes is not filed as bookkeeping. A pack whose writes cannot be
 * read is a data change — never quietly bookkeeping.
 */
function packageOfHeldWrites(data: unknown): ReviewPackage {
  const { writes, unreadable } = readDeferredWrites(data);
  if (writes.length === 0 || unreadable > 0) return "data-changes";
  let best: ReviewPackage | null = null;
  for (const w of writes) {
    const pkg = decide({
      proposalType: w.action,
      targetType: w.subjectType,
      objectKind:
        typeof w.data.profileSlug === "string" ? w.data.profileSlug : null,
    }).package;
    if (best === null || reviewPackageRank(pkg) < reviewPackageRank(best))
      best = pkg;
  }
  return best ?? "data-changes";
}

function decide(input: ReviewPackageInput): ReviewPackageDecision {
  const kind = input.kind ?? null;
  if (kind && kind !== "proposal-cluster") {
    return {
      package: ACCESS_SIGNAL_KINDS.has(kind) ? "access" : "questions",
      rule: "signal",
    };
  }
  const type = input.proposalType ?? "";
  const target = input.targetType ?? "";
  const pair = `${target}/${type}`;

  if (pair === "agent/held_writes")
    return { package: packageOfHeldWrites(input.data), rule: "pack" };

  const byPair = BY_PAIR[pair];
  if (byPair) return { package: byPair, rule: "pair" };

  if (input.class === "access") return { package: "access", rule: "class" };

  const byType = Object.hasOwn(BY_PROPOSAL_TYPE, type)
    ? BY_PROPOSAL_TYPE[type]
    : type.startsWith("governance.")
      ? "how-things-work"
      : undefined;
  if (byType) return { package: byType, rule: "type" };

  if (isBookkeepingWrite(type, target) && input.filedByPerson !== true)
    return { package: "bookkeeping", rule: "bookkeeping" };

  if (
    target === "entity" &&
    type === "create" &&
    input.objectKind &&
    KNOWLEDGE_OBJECT_KINDS.has(input.objectKind)
  )
    return { package: "knowledge", rule: "kind" };
  if (target === "knowledgeKey")
    return { package: "knowledge", rule: "target" };

  if (ACCESS_TARGETS.has(target)) return { package: "access", rule: "target" };
  if (HOW_TARGETS.has(target))
    return { package: "how-things-work", rule: "target" };
  if (DATA_TARGETS.has(target))
    return { package: "data-changes", rule: "target" };

  return { package: "data-changes", rule: "fallback" };
}

/**
 * The package an item files under, and the rule that decided it. A `fallback`
 * decision is a pair nobody taught this function: it is still filed (as a
 * data change, the package that asks a person to look at each row), and the
 * coverage tripwire fails on any governed door that reaches it.
 */
export function reviewPackageDecision(
  input: ReviewPackageInput
): ReviewPackageDecision {
  return decide(input);
}

/** The package an item files under — THE classifier every surface reads. */
export function reviewPackageOf(input: ReviewPackageInput): ReviewPackage {
  return decide(input).package;
}
