/**
 * Domain vocabulary — the SSOT for turning machine tokens into human words.
 *
 * WHY THIS EXISTS. Across the Synap repos ~150 ad-hoc label maps and ~170
 * switch statements independently answer "what do we CALL this?" for the same
 * domain values. They disagree in user-visible ways: `rejected` renders as
 * "Refused" in one governance surface and "Rejected" in another; `delete`
 * renders as "Deleted" / "Delete" / "Removed"; some surfaces leak the raw
 * machine token (`entity.create`) straight to the user.
 *
 * WHAT BELONGS HERE. Only DOMAIN vocabulary — the nouns (object kinds) and
 * verbs (actions) of the Synap model. NOT value formatting (dates, durations,
 * byte sizes, relative time): those are a different SSOT with different rules,
 * and folding them in here is how a focused registry becomes a junk drawer.
 *
 * WHY NOT i18n. This is a key→word lookup, not message formatting; the vast
 * majority of sites need no interpolation and no plurals. Keeping the vocabulary
 * as typed data (rather than an English catalog) is what lets a future i18n
 * layer resolve `key → locale` mechanically. Registry first; translation on top
 * only if the product is ever localized.
 *
 * Pure + dependency-free — safe to import from browser, Electron, and server
 * contexts (same contract as `proposals/proposal-utils.ts`).
 */

import { OBJECT_KINDS, OBJECT_KIND_ALIASES } from "./object-kinds.js";

/**
 * The object-kind identity registry lives in `./object-kinds` and is re-exported
 * here so `@synap-core/types/vocabulary` is the ONE door for domain vocabulary —
 * nouns (kinds), verbs (actions) and statuses alike.
 */
export * from "./object-kinds.js";

/**
 * Turn a machine token into a human word: strip a dotted namespace, split
 * `snake_case`/`kebab-case`/`camelCase`, and sentence-case the result.
 *
 *   "focus_session"          → "Focus session"
 *   "governance.widen_lane"  → "Widen lane"
 *   "capabilityKind"         → "Capability kind"
 *
 * This is the fallback for a token with no curated entry — it must never
 * return the raw token, because a leaked `entity.create` in the UI is the
 * defect this module exists to remove.
 */
export function humanizeToken(token: string): string {
  const tail = token.includes(".")
    ? token.slice(token.lastIndexOf(".") + 1)
    : token;
  const words = tail
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * An action's two MOODS. Both are correct; they are not interchangeable:
 *   - `imperative` — what approving it WILL do. Buttons, pending proposals.
 *   - `past`       — what already happened. History, event feeds, receipts.
 *
 * These were previously an accidental fork (`event-renderer` said "Created",
 * `ProposalChrome` said "Create"). Collapsing them into one column would
 * replace two correct strings with one wrong one, so the distinction is
 * encoded here deliberately.
 */
export interface ActionVerb {
  imperative: string;
  past: string;
}

export type VerbMood = keyof ActionVerb;

/**
 * Curated verbs. Keys are matched on the LAST dotted segment as well as the
 * whole token, so `capability.run` and `run` resolve identically. Anything
 * absent falls back to {@link humanizeToken}, which is always safe.
 */
export const ACTION_VERBS: Readonly<Record<string, ActionVerb>> = {
  create: { imperative: "Create", past: "Created" },
  update: { imperative: "Update", past: "Updated" },
  delete: { imperative: "Delete", past: "Deleted" },
  archive: { imperative: "Archive", past: "Archived" },
  restore: { imperative: "Restore", past: "Restored" },
  run: { imperative: "Run", past: "Ran" },
  merge: { imperative: "Merge", past: "Merged" },
  link: { imperative: "Link", past: "Linked" },
  unlink: { imperative: "Unlink", past: "Unlinked" },
  attach: { imperative: "Attach", past: "Attached" },
  detach: { imperative: "Detach", past: "Detached" },
  install: { imperative: "Install", past: "Installed" },
  enable: { imperative: "Enable", past: "Enabled" },
  disable: { imperative: "Disable", past: "Disabled" },
  // Pause/resume is the register for something that RUNS (an automation with a
  // live trigger, a session): it was running and will run again. Enable/disable
  // is the register for a config FLAG. They are not synonyms — using the flag
  // words for a running processor loses the "will run again" meaning.
  pause: { imperative: "Pause", past: "Paused" },
  resume: { imperative: "Resume", past: "Resumed" },
  join: { imperative: "Join", past: "Joined" },
  import: { imperative: "Import", past: "Imported" },
  capture: { imperative: "Capture", past: "Captured" },
  send: { imperative: "Send", past: "Sent" },
  approve: { imperative: "Approve", past: "Approved" },
  // The decision verb for OBJECT-WORK proposals — a proposed entity that
  // renders as the entity, editable, in a draft state. Approving that is not
  // reviewing a diff, it is finishing a draft, and the verb should say so.
  // Both moods matter: "Publish" on the button, "Published" in the receipt.
  publish: { imperative: "Publish", past: "Published" },
  // Governance surfaces disagreed on this one ("Refused" vs "Rejected").
  // "Reject" is the canonical pair — it matches the API verb and the
  // `PROPOSAL_REJECTION_REASONS` taxonomy.
  reject: { imperative: "Reject", past: "Rejected" },
  set: { imperative: "Set", past: "Set" },
  request: { imperative: "Request", past: "Requested" },
  revise: { imperative: "Revise", past: "Revised" },
};

/**
 * The human verb for an action token, in the requested mood.
 * Unknown tokens humanize rather than leak (`"declare_source"` → "Declare source").
 */
export function resolveActionLabel(
  action: string | null | undefined,
  mood: VerbMood = "imperative"
): string {
  if (!action) return "";
  const key = action.toLowerCase();
  const tail = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  const verb = ACTION_VERBS[key] ?? ACTION_VERBS[tail];
  return verb ? verb[mood] : humanizeToken(action);
}

/**
 * Object-kind nouns the kind registry does NOT model.
 *
 * The noun SSOT is `OBJECT_KINDS` + `OBJECT_KIND_ALIASES` in `./object-kinds`
 * — ONE table, in this package, re-exported by `@synap-core/object-registry`
 * for the frontend. This map is NOT a second table: it is the short tail of
 * BACKEND-ONLY subject types that never appear on a rendered surface as an
 * object (so they have no icon/color identity) yet still have to be titled in
 * a proposal, and whose display name is not their humanized slug.
 *
 * Anything the registry DOES model resolves through it — never duplicate a
 * registry kind here; that is exactly the fork this consolidation removed.
 */
export const OBJECT_NOUNS: Readonly<Record<string, string>> = {
  relation_def: "Relation type",
  mcp: "MCP server",
  api_key: "API key",
  ssh_key: "SSH key",
  env_variable: "Environment variable",
  url: "Page",
};

/**
 * The human noun for an object kind / target type.
 *
 * Resolution order: backend-only tail → the ONE alias table
 * (`focus_session` → `session`, `relation` → `link`) → the registry's curated
 * label → {@link humanizeToken}, which is always safe. Nothing can leak a raw
 * token, and there is exactly one place a kind's name is decided.
 */
export function resolveObjectNoun(kind: string | null | undefined): string {
  if (!kind) return "";
  const key = kind.toLowerCase();
  const backendOnly = OBJECT_NOUNS[key];
  if (backendOnly) return backendOnly;
  const canonical = OBJECT_KIND_ALIASES[key] ?? key;
  return OBJECT_KINDS[canonical]?.label ?? humanizeToken(canonical);
}

/**
 * Compose a proposal title from its structured parts — the ONE place the
 * "<verb> <noun> "<name>"" sentence is built.
 *
 * `action` prefers the proposal's own `proposalType` over `changeType`, because
 * `changeType` is unreliable: a proposal whose payload carries no `changeType`
 * is defaulted to `"update"` upstream, which is how every capability RUN came
 * to be titled "Update Capability" — it updates nothing, it runs a call.
 */
export function buildObjectActionTitle(params: {
  /** Preferred action token (e.g. a proposalType like `run`). */
  action?: string | null;
  /** Fallback action token (e.g. `changeType`) when `action` is absent. */
  fallbackAction?: string | null;
  /** The kind of thing acted on (profileSlug wins over targetType). */
  objectKind?: string | null;
  /** The specific object's name, when known. */
  objectName?: string | null;
  mood?: VerbMood;
}): string {
  const { action, fallbackAction, objectKind, objectName, mood } = params;
  const verb = resolveActionLabel(
    action ?? fallbackAction,
    mood ?? "imperative"
  );
  // `entity` is the generic base kind — naming it adds nothing ("Create
  // Entity"), so it is suppressed in favour of the concrete profile slug.
  const noun =
    objectKind && objectKind.toLowerCase() !== "entity"
      ? resolveObjectNoun(objectKind)
      : "";
  const head = [verb || "Proposal", noun].filter(Boolean).join(" ");
  return objectName ? `${head} "${objectName}"` : head;
}

/**
 * Proposal-KIND labels — the SHAPE of a proposed change ("what kind of
 * proposal is this"), shown as a chip on every proposal card/detail surface.
 * This is its OWN taxonomy: distinct from an object kind (what THING it acts
 * on, resolved by {@link resolveObjectNoun}) and from an action verb (what
 * happens on approval, resolved by {@link resolveActionLabel}). `facet` and
 * `composite` prove the distinction — neither reads as its literal object
 * noun or action verb: a `facet` proposal reads as "Role" (the product's own
 * word for what a facet grants — see the "Kind + Facets" model) and a
 * `composite` proposal reads as "Bundle" (several operations, not one).
 *
 * Curated here because relay's own local map (pre-consolidation) had ALREADY
 * forked from `synap-app/packages/core/proposal-ui/ProposalChrome.tsx`'s local
 * map: `facet` was "Role" in one and "Facet" in the other; `composite` was
 * "Bundle" vs "Multi-entity" — and the latter's `?? presentation.kind`
 * fallback leaked the raw token for any kind it didn't list (e.g. `install`,
 * every `governance_*` kind). This table is the ONE place both should resolve
 * kind, so a reviewer sees the same word on the card and the detail screen
 * regardless of which repo renders it.
 */
export const PROPOSAL_KIND_LABELS: Readonly<Record<string, string>> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  document: "Document",
  link: "Link",
  facet: "Role",
  composite: "Bundle",
  session: "Session",
  merge: "Merge",
  install: "Install",
  // Governance recommender kinds — reviewer never approved these before; the
  // chip is the FIRST thing they read, so it names the change, not the token.
  governance_widen: "Widen a lane",
  governance_tighten: "Tighten a lane",
  governance_raise_ceiling: "Raise a ceiling",
  governance_tighten_posture: "Tighten posture",
  capability_run: "Run capability",
  automation_run: "Run automation",
};

/**
 * The human label for a proposal kind. Unknown/new kinds humanize rather than
 * leak, so a future `ProposalKind` addition is safe (if unpolished) before
 * this table is updated.
 */
export function resolveProposalKindLabel(
  kind: string | null | undefined
): string {
  if (!kind) return "";
  return PROPOSAL_KIND_LABELS[kind.toLowerCase()] ?? humanizeToken(kind);
}

/**
 * Lifecycle STATUS labels — the state a thing is in, as a human word.
 *
 * SCOPE. These are the CANONICAL lifecycle states of Synap's own objects
 * (proposals, runs, steps, sessions). They are NOT a dumping ground for every
 * string that happens to be keyed `failed`:
 *   - Empty-state copy ("No failed runs.") is a SENTENCE, not a status label.
 *   - A report section's provenance ("Did not run" / "Stopped early") is a
 *     DIFFERENT domain with its own vocabulary — a section that never ran is
 *     not a run that errored. Flattening those into "Failed" would destroy a
 *     real distinction, the same way collapsing the two verb moods would.
 * Adopt this table only where the value really is an object lifecycle state.
 */
export const STATUS_LABELS: Readonly<Record<string, string>> = {
  // proposal lifecycle
  pending: "Pending",
  approved: "Approved",
  auto_approved: "Auto-approved",
  // "Refused" (GovernanceHistory) vs "Rejected" (ProposalInbox) was a real
  // user-visible split. "Rejected" wins: it matches the API verb, the
  // `PROPOSAL_REJECTION_REASONS` taxonomy, and the DB enum value.
  rejected: "Rejected",
  denied: "Rejected",
  approval_failed: "Approval failed",
  // NOT a `proposals.status` enum value, and deliberately so: partial approval
  // ships as per-item dispositions, the row keeps storing `approved`, and the
  // reviewer's per-item denials live in `data.dispositions`. It IS a real
  // proposal lifecycle OUTCOME though — "the reviewer kept part of the package
  // and threw the rest away" — and more than one surface has to name it (the
  // agent trust grid, the agent dossier scorecard). One word here beats two
  // hand-written ones there. Do NOT add it to the DB enum on the strength of
  // this row.
  partially_approved: "Partially approved",
  withdrawn: "Withdrawn",
  expired: "Expired",
  // run / step lifecycle
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  // ⚠️ OVERLOADED TOKEN — deliberately rendered as the neutral word.
  // `stale` means three different things in this product: a session the reaper
  // gave up on (progress), a sync that is out of date (freshness), and a broken
  // renderer binding. "Stalled" imposes the progress reading; "Out of date"
  // imposes the freshness one. Both are wrong somewhere, so this table — which
  // is GLOBAL and cannot know the domain — stays neutral. A surface that knows
  // its domain should supply its own word (the data-sync and renderer surfaces
  // already do) rather than call this resolver.
  stale: "Stale",
  // generic on/off — surfaces disagreed ("Active/Paused" vs "Enabled/Disabled"
  // vs "On/Off"). These two are the canonical pair for an enabled flag.
  enabled: "Enabled",
  disabled: "Disabled",
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  archived: "Archived",
};

/**
 * The human label for a lifecycle status. Unknown values humanize rather than
 * leak, so a new DB enum value can never render as a raw token.
 */
export function resolveStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return STATUS_LABELS[status.toLowerCase()] ?? humanizeToken(status);
}
