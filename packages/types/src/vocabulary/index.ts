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
  // A NEW run of stored input with the current guidelines (intake plan §4.3 —
  // a rerun is a new session `spawned_from` the previous one). "Rerun" on the
  // button and pending item; "Reran" on the history receipt. Added ahead of its
  // producer, for the W2 rerun door, so that door never hand-writes a label.
  rerun: { imperative: "Rerun", past: "Reran" },
  // `capture.complete.completed` is emitted by `routers/capture.ts` and by
  // `buildEventPattern`, so this token reaches users. Without a row here
  // `resolveActionLabel(action, "past")` fell through to `humanizeToken`,
  // which has NO tense and silently ignores the mood — so a settled history
  // row rendered "Complete Capture", present-imperative, as if the agent were
  // about to act. See the mood-coverage test in this package.
  complete: { imperative: "Complete", past: "Completed" },
  // `external_message.received.completed`. This one was invisible because
  // `humanizeToken("received")` happens to spell the PAST form — so the past
  // mood looked correct while the imperative silently returned "Received"
  // too. A coincidence is not a contract.
  //
  // ⚠️ Keyed on `received`, the token the producer actually emits — NOT on a
  // base form `receive`. I added both; `receive` had zero occurrences across
  // all four repos, so it was a row nobody could reach, and it put a
  // second spelling of one verb into a table whose whole job is to have one.
  // A key here earns its place by being emitted, not by being well-formed.
  received: { imperative: "Receive", past: "Received" },
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
  // A proposer retracting their own pending ask — NOT a review outcome.
  // Added 2026-09-07: `STATUS_LABELS.withdrawn` existed but there was no
  // ACTION verb, so `resolveActionLabel("withdraw", "past")` fell through to
  // `humanizeToken`, which IGNORES the mood argument and returned the
  // present-imperative "Withdraw" into past-tense receipts.
  withdraw: { imperative: "Withdraw", past: "Withdrawn" },
  set: { imperative: "Set", past: "Set" },
  request: { imperative: "Request", past: "Requested" },
  revise: { imperative: "Revise", past: "Revised" },
  // Session→config conversions (workbench Wave B). Promote turns a validated
  // session into a reusable playbook; spawn turns one into a project. Both are
  // STRUCTURE-ONLY conversions, and both are named on a receipt that must read
  // in the past ("Promoted to playbook X") while the button reads imperative.
  promote: { imperative: "Promote", past: "Promoted" },
  spawn: { imperative: "Spawn", past: "Spawned" },
  // Triage decisions on an agent/automation-originated session. "Accept" is the
  // affirmative half of the pair whose negative is `discard` — deliberately NOT
  // `approve`/`reject`, which name a PROPOSAL decision. Triage is not governance:
  // nothing was proposed, a session simply appeared and a person says whether it
  // is theirs to work.
  accept: { imperative: "Accept", past: "Accepted" },
  discard: { imperative: "Discard", past: "Discarded" },
  // Undo of a conversion — the inverse verb, not a delete.
  revert: { imperative: "Revert", past: "Reverted" },
  // Server-side dev-loop HUMAN GATES (`dev.plan_approval` /
  // `dev.deploy_approval`). Verbs are matched on the LAST dotted segment, so
  // these keys resolve the full proposal types. They are NOT bare "approve":
  // "Approve" alone is the decision VERB every proposal card already shows on
  // its button, so a gate labelled "Approve" would read "Approve · Approve" and
  // lose the only word that says WHICH gate a person is standing at. Both moods
  // matter — the button asks, the session receipt reports.
  plan_approval: { imperative: "Approve plan", past: "Approved plan" },
  deploy_approval: { imperative: "Approve deploy", past: "Approved deploy" },
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
  // Humanizing this event domain to "Proactive" loses its subject — the AI is
  // what's proactive here (an unprompted post/action), not a generic quality.
  // Ported from event-renderer's local `DOMAIN_NAMES` map, which the vocabulary
  // consolidation narrowed to grouping-only (see `renderers.tsx`).
  proactive: "Proactive AI",
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
  return (
    OBJECT_KINDS[canonical]?.label ??
    OBJECT_NOUNS[canonical] ??
    humanizeToken(canonical)
  );
}

/**
 * The human noun for an object kind, PLURAL.
 *
 * The registry already carries a curated plural on every kind (`labelPlural` is
 * a required field), and it is not always the singular plus "s": `person` →
 * "People", `company` → "Companies", `entity` → "Entities". Appending an `s` at
 * a call site produces "your persons" and "your companys", which is precisely
 * the hand-written label map `.claude/rules/vocabulary.md` forbids — and it was
 * shipped once, in relay's reference-param sheet, before a review caught it.
 *
 * Same resolution order as {@link resolveObjectNoun}. The backend-only tail has
 * no curated plural, so those fall back to the singular + "s"; every one of them
 * ("API key", "SSH key", "MCP server", "Relation type", "Environment variable",
 * "Page") pluralises correctly that way.
 */
export function resolveObjectNounPlural(
  kind: string | null | undefined
): string {
  if (!kind) return "";
  const key = kind.toLowerCase();
  const backendOnly = OBJECT_NOUNS[key];
  if (backendOnly) return `${backendOnly}s`;
  const canonical = OBJECT_KIND_ALIASES[key] ?? key;
  const entry = OBJECT_KINDS[canonical];
  if (entry?.labelPlural) return entry.labelPlural;
  const canonicalNoun = OBJECT_NOUNS[canonical];
  if (canonicalNoun) return `${canonicalNoun}s`;
  return `${humanizeToken(canonical)}s`;
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
  // Guideline recommenders — each asks the reviewer to adopt standing guideline
  // TEXT: one for how extraction reads a data type, one for how blocked work is
  // handled.
  governance_structure_guideline: "Extraction guideline",
  governance_work_guideline: "Work guideline",
  capability_run: "Run capability",
  automation_run: "Run automation",
  // Server-side dev-loop HUMAN GATES. The chip is the first thing a reviewer
  // reads, and the two gates ask genuinely different questions — one is about
  // work not yet done, one is about shipping work already verified — so they
  // get two chips, never one shared "Dev approval".
  dev_plan_approval: "Approve a plan",
  dev_deploy_approval: "Approve a deploy",
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
  // connection sync phases (K2 `SyncPhase`, `connection-sync.ts`). `failed` is
  // shared with the run lifecycle above. `mapping` is what the user sees happen
  // — records matched against what is already in Synap — not the mapper's name.
  fetching: "Fetching",
  mapping: "Matching",
  review_ready: "Ready to review",
  synced: "Synced",
  // external connection states (capability card `connection.state`). The card's
  // own token for "no connection" is `missing`, which is too generic for a global
  // table ("missing" means other things elsewhere), so surfaces map it to
  // `disconnected` before resolving.
  connected: "Connected",
  disconnected: "Not connected",
  unavailable: "Not available",
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
  // session work-state lenses (derived, never stored — a session is "waiting"
  // because an open `blocked_by` edge points at an open session, "ready" when
  // none does, "done" when closed). These are lens names over one row set,
  // not `focus_sessions.status` values; keep them out of the DB enum.
  ready: "Ready",
  waiting: "Waiting",
  blocked: "Blocked",
  done: "Done",
  // an agent- or automation-originated session not yet accepted from triage
  drafted: "Drafted",
  // ⚠️ NOT the same idea as `drafted` above, and the two must never be
  // collapsed. `drafted` waits for a PERSON (has anyone accepted this
  // suggestion?); `scheduled` waits for a CLOCK (this session starts at a
  // time). A `focus_sessions.status` value — unlike `drafted`, which is a
  // triage lens name. It reached users only through the `humanizeToken`
  // fallback until now; that fallback exists to stop a raw token leaking, not
  // as an endorsement, so the state is spelled out here.
  scheduled: "Scheduled",
  // session POPULATION lenses (derived, never stored — see
  // `services/focus-sessions/session-kind.ts`): one `focus_sessions` table
  // holds a person's units of work, machine executions, and the containers an
  // agent's writes are filed under. Lens names over one row set, like the
  // work-state block above — NOT `focus_sessions.status` values, and not to be
  // added to the DB enum. `run` is spelled out rather than left to humanize so
  // it cannot drift from the object-kind noun of the same name.
  work: "Work",
  run: "Run",
  receipt: "Receipt",
};

/**
 * The human label for a lifecycle status. Unknown values humanize rather than
 * leak, so a new DB enum value can never render as a raw token.
 */
export function resolveStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return STATUS_LABELS[status.toLowerCase()] ?? humanizeToken(status);
}

/**
 * PROVENANCE labels — "who or what produced this", as a human word.
 *
 * ── Why this table exists BEFORE anything renders provenance ───────────────
 * The database carries THREE incompatible spellings of the same idea, and
 * `generated.d.ts` documents the fork as intentional:
 *
 *   `ProvenanceKind`               human | ai_agent | system
 *     (`schema/provenance.ts` — entities, documents, relations, facets)
 *   `CellInstanceCreatedByKind`    user  | agent    | system
 *     (`schema/cell-instances.ts`)
 *   `messages.authorType`          human | ai_agent | external | bot
 *
 * That fork is HARMLESS today for exactly one reason: no frontend file renders
 * either column. The moment one does, the surface has to turn `ai_agent` into
 * a word — and `.claude/rules/vocabulary.md` forbids it hand-writing a label
 * map to do so. This is that door, opened first, so the first renderer has
 * somewhere to go.
 *
 * `human`/`user` resolve to the SAME word, and so do `ai_agent`/`agent`. That
 * collapse is the point: they are two DB spellings of one idea, and a user
 * must never be able to tell from the screen which table a row came out of.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 *  • It does NOT unify the DB enums. Three columns with different value sets
 *    is a migration and a separate decision; this unifies the LABEL only.
 *  • It is NOT a predicate. "Was this agent-made?" is a governance question
 *    answered by the policy engine, never by comparing a display string.
 *  • `external` and `bot` are NOT folded into the others. A WhatsApp contact
 *    who sent a message is a PERSON outside the pod, and a system-generated
 *    bot message is neither a person nor an AI agent. Flattening those into
 *    "Person"/"AI agent" would destroy a real distinction — the same mistake
 *    as collapsing the two verb moods.
 */
export const PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  // ProvenanceKind + messages.authorType
  human: "Person",
  // CellInstanceCreatedByKind — the same idea, spelled differently.
  user: "Person",
  ai_agent: "AI agent",
  agent: "AI agent",
  system: "System",
  // messages.authorType only: a real person reaching the pod from OUTSIDE it
  // (WhatsApp, Slack) — not a pod user, and not an agent.
  external: "External",
  // messages.authorType only: an automated system message. Distinct from
  // `ai_agent` (a reasoning agent) and from `system` (the platform itself).
  bot: "Bot",
};

/**
 * The human label for a provenance value, whichever of the three columns it
 * came from. Unknown values humanize rather than leak, so a new DB enum member
 * can never reach a user as a raw token.
 */
export function resolveProvenanceLabel(
  kind: string | null | undefined
): string {
  if (!kind) return "";
  return PROVENANCE_LABELS[kind.toLowerCase()] ?? humanizeToken(kind);
}

/**
 * BLOCKED-REASON labels — why an agent could not take a deliverable, as a
 * human word.
 *
 * ── Why this is its OWN table, not a STATUS_LABELS block ───────────────────
 * `STATUS_LABELS`'s own scope note says it holds LIFECYCLE STATES and is not a
 * dumping ground. A blocked reason is not a state the slot is in — the slot is
 * `pending`, same as any other. It is a CLASSIFICATION of the obstacle, a
 * different closed domain, and it collides on `capability` and `decision` with
 * `OBJECT_NOUNS` — two tables that must not merge.
 *
 * ── Why the labels are not just `humanizeToken` ────────────────────────────
 * They would be ambiguous. Rendered bare, "Capability" and "Decision" read as
 * the OBJECT KINDS of the same name (a capability record, a decision record),
 * not as "the tool does not exist" and "a person has to choose". The parallel
 * "<thing> missing" / "<thing> block" phrasing is deliberate: the six read as
 * one taxonomy at a glance, which is the whole job of a closed set.
 *
 * MOOD does not apply — these are not verbs. A blocker is named the same way
 * whether it is open or was cleared last week; the tense lives on the slot's
 * own lifecycle, not here.
 *
 * The value set is defined ONCE, as `BLOCKED_REASONS` in `@synap/playbooks`
 * (the home of the `ExpectedOutput` interface that carries it). This package
 * is dependency-free by design and so mirrors the keys; the parity tripwire in
 * `@synap/api` (`__tripwires__/blocked-reason-vocabulary-parity.test.ts`)
 * derives the set from that constant and fails if a value has no label here.
 */
export const BLOCKED_REASON_LABELS: Readonly<Record<string, string>> = {
  /** A secret to mint or store. */
  credential: "Credential missing",
  /** A governance rule to write. */
  permission: "Permission missing",
  /** The tool does not exist. NOT the `capability` object kind. */
  capability: "Capability missing",
  /** A rule to change, or to accept. */
  policy: "Policy block",
  /** Honestly terminal: a choice only a person can make. */
  decision: "Human decision",
  /** Honestly terminal: an action in the world. */
  physical: "Physical action",
};

/**
 * The human label for a blocked reason. Unknown values humanize rather than
 * leak — but the set is CLOSED at the parse (`expectedOutputWireSchema`), so an
 * unknown value reaching here means something bypassed a door, not that the
 * taxonomy grew.
 */
export function resolveBlockedReasonLabel(
  reason: string | null | undefined
): string {
  if (!reason) return "";
  return BLOCKED_REASON_LABELS[reason.toLowerCase()] ?? humanizeToken(reason);
}
