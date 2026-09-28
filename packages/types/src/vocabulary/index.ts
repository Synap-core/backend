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
import type { SpaceBrief } from "../space-brief/index.js";
import type { TrustRung } from "../trust-ladder/index.js";

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
 * Sentence-case a STORED display label so labels from different sources read
 * alike — the same casing {@link humanizeToken} gives a token, applied to a
 * label someone already wrote. Title Case words lower-case ("Works At" →
 * "Works at"); words carrying deliberate casing stay (acronyms "CEO", mixed
 * "iPhone", "McKinsey"). A label with no space that looks like a token
 * (`works_at`, `worksAt`) goes through {@link humanizeToken} itself.
 *
 *   "Belongs To Project" → "Belongs to project"
 *   "Reports To CEO"     → "Reports to CEO"
 *   "met at"             → "Met at"
 */
export function sentenceCaseLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (!/\s/.test(trimmed) && /[_-]|[a-z0-9][A-Z]/.test(trimmed)) {
    return humanizeToken(trimmed);
  }
  return trimmed
    .split(/\s+/)
    .map((word, i) => {
      const plain = /^[A-Z]?[a-z]*$/.test(word.replace(/[^A-Za-z]/g, ""));
      if (!plain) return word; // deliberate casing: CEO, iPhone, McKinsey
      const lower = word.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
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
  // TWO distinct acts, two verbs. `revert` takes an APPLIED proposal's effect
  // back (the history row: it lands in `reverted`). `undo` is the seconds-later
  // "I did not mean to decide that yet" on a verdict just given — it puts the
  // proposal back in the queue. Sharing one word made the same button mean two
  // things on adjacent surfaces.
  undo: { imperative: "Undo", past: "Undone" },
  // Re-running an approval that already failed (`approval_failed`). The write
  // was approved once, so "Approve" is the wrong word on that button — and for a
  // transient provider outage it is the reviewer's ONLY recovery.
  retry: { imperative: "Retry", past: "Retried" },
  // Put a REJECTED proposal back in the queue — the inverse of reject. Without
  // a row `resolveActionLabel("reopen", …)` fell through to `humanizeToken`,
  // which has no tense and only spelled "Reopen" by luck.
  reopen: { imperative: "Reopen", past: "Reopened" },
  // Pod hygiene (`profile/retire`, the cleanup pack). `retire` is a SOFT,
  // reversible hide of a kind — not a delete, so it never reads "Deleted".
  // `close` ends an idle session through the close door; `expire` takes a
  // long-waiting proposal out of the queue without applying it.
  retire: { imperative: "Retire", past: "Retired" },
  close: { imperative: "Close", past: "Closed" },
  expire: { imperative: "Expire", past: "Expired" },
  // Sharing (Sites W2–W5, `services/sharing/share-service.ts`). `publish`
  // above is reused for putting a record on the public web — one word for one
  // act, whether it finishes a draft or opens a record to strangers. `unshare`
  // and `unpublish` NARROW (reversible: sharing again restores access);
  // `revoke` is PERMANENT (0276: a revoked link row is frozen, sharing again
  // mints a new one), so it must never be rendered as "Unshared". `redeem` is a
  // signed-in person turning a link into a guest membership.
  share: { imperative: "Share", past: "Shared" },
  unshare: { imperative: "Unshare", past: "Unshared" },
  unpublish: { imperative: "Unpublish", past: "Unpublished" },
  revoke: { imperative: "Revoke", past: "Revoked" },
  redeem: { imperative: "Redeem", past: "Redeemed" },
  // Governed space operations (R8a/P1). `move` is emitted by
  // `entities.moveToWorkspace` (audit `entity.move`) and titles a move
  // proposal; `rename` titles a space rename; `grant_access` is the stored
  // proposalType of `profiles.grantAccess` — a person reads it as SHARING a
  // kind with another space, so it wears `share`'s words, not "Grant access".
  // Without rows the past mood fell through to `humanizeToken` ("Move").
  move: { imperative: "Move", past: "Moved" },
  rename: { imperative: "Rename", past: "Renamed" },
  grant_access: { imperative: "Share", past: "Shared" },
  // Filing EXISTING records into a project (`project/file_entities`) and
  // taking them back out (a `belongs_to_project` link delete). One verb pair
  // for the act a person names "filing"; never "Link"/"Delete".
  file_entities: { imperative: "File", past: "Filed" },
  unfile_entities: { imperative: "Unfile", past: "Unfiled" },
  // Server-side dev-loop HUMAN GATES (`dev.plan_approval` /
  // `dev.deploy_approval`). Verbs are matched on the LAST dotted segment, so
  // these keys resolve the full proposal types. They are NOT bare "approve":
  // "Approve" alone is the decision VERB every proposal card already shows on
  // its button, so a gate labelled "Approve" would read "Approve · Approve" and
  // lose the only word that says WHICH gate a person is standing at. Both moods
  // matter — the button asks, the session receipt reports.
  plan_approval: { imperative: "Approve plan", past: "Approved plan" },
  deploy_approval: { imperative: "Approve deploy", past: "Approved deploy" },
  // Document-edit proposal types (`DOCUMENT_PATCH_PROPOSAL_TYPES` + the legacy
  // `ai_edit`), filed against an EXISTING document by the pod's patch door.
  // Without rows they humanized to "Section update" / "Ai edit" and composed
  // `Section update Document "…"` — a noun where the verb belongs. Like the
  // dev gates above, a verb that names the PART it acts on carries that noun,
  // and `ACTION_OBJECT_PREPOSITIONS` joins it to the document it lives in.
  section_update: { imperative: "Edit section", past: "Edited section" },
  session_narrative_update: {
    imperative: "Update narrative",
    past: "Updated narrative",
  },
  ai_edit: { imperative: "Edit", past: "Edited" },
  // `user_edit` is a PERSON's suggested change to a document, reviewed like
  // any other proposal — so it reads as a suggestion, not as an edit made.
  user_edit: { imperative: "Suggest edit", past: "Suggested edit" },

  // Account setup / landing page verbs
  provision: { imperative: "Provision", past: "Provisioned" },
  download: { imperative: "Download", past: "Downloaded" },
  sign_in: { imperative: "Sign in", past: "Signed in" },
  start: { imperative: "Start", past: "Started" },
  check: { imperative: "Check", past: "Checked" },
  compare: { imperative: "Compare", past: "Compared" },
  see: { imperative: "See", past: "Seen" },
  open: { imperative: "Open", past: "Opened" },
};

/**
 * Verbs that already name the PART they act on ("Edit section") take a
 * preposition before the object they act WITHIN, so a title reads
 * `Edit section in Document "Plan"` rather than `Edit section Document "Plan"`.
 * Keyed like {@link ACTION_VERBS} (whole token, then last dotted segment).
 */
export const ACTION_OBJECT_PREPOSITIONS: Readonly<Record<string, string>> = {
  section_update: "in",
  session_narrative_update: "of",
};

function resolveActionPreposition(action: string | null | undefined): string {
  if (!action) return "";
  const key = action.toLowerCase();
  const tail = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  return (
    ACTION_OBJECT_PREPOSITIONS[key] ?? ACTION_OBJECT_PREPOSITIONS[tail] ?? ""
  );
}

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

/** Which end of a lineage edge the reader is standing on. */
export type LineageDirection = "incoming" | "outgoing";

/**
 * Lineage edge labels — how "what made this / what this made" reads.
 *
 * Keyed by the lineage relation, read from the FOCUSED object's side:
 *   - `produced` — the `document --produced--> entity` link. On the entity
 *     (incoming) it reads "Made from" the capture; on the capture (outgoing)
 *     it reads "Made" the entity.
 *   - `rerun` — a rerun session is `spawned_from` the run it replays. Keyed
 *     `rerun`, not `spawned_from`: a plain fork is also `spawned_from`, and
 *     only a reader that knows the child is a rerun (its run manifest) may
 *     call it "Rerun of".
 *
 * A direction with no curated label humanizes, never leaks.
 */
export const LINEAGE_EDGE_LABELS: Readonly<
  Record<string, Readonly<Partial<Record<LineageDirection, string>>>>
> = {
  produced: { incoming: "Made from", outgoing: "Made" },
  rerun: { outgoing: "Rerun of" },
};

export function resolveLineageEdgeLabel(
  edge: string | null | undefined,
  direction: LineageDirection
): string {
  if (!edge) return "";
  return (
    LINEAGE_EDGE_LABELS[edge.toLowerCase()]?.[direction] ?? humanizeToken(edge)
  );
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
  // Sharing (Sites). A SHARE LINK (a `resource_shares` row with audience
  // `link`, redeemed into a guest membership) is NOT a `link` — `link` is the
  // canonical noun of a RELATION (`relation` → `link` in OBJECT_KIND_ALIASES).
  // Its own key keeps the two apart: `share_link` → "Share link", `link` /
  // `relation` → "Link". Never alias one to the other.
  share_link: "Share link",
  // A person outside the workspace who was given access to one project
  // (`project_members.role = 'guest'`) — or who filed through a public form.
  guest: "Guest",
  // A public form (a `tools` row carrying `metadata.form`, W4) and what a
  // stranger sends through it. Neither is a registry kind: a form renders as
  // its tool, a submission as the proposal / record it became.
  form: "Form",
  submission: "Submission",
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
  return pluralizeFallback(humanizeToken(canonical));
}

/**
 * The uncurated fallback: singular + "s", except a consonant + "y" ending,
 * which takes "ies" — `property` (an alias target with no registry entry)
 * rendered "Propertys" through the bare-`s` rule.
 */
function pluralizeFallback(noun: string): string {
  return /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
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
  const actionToken = action ?? fallbackAction;
  const verb = resolveActionLabel(actionToken, mood ?? "imperative");
  // `entity` is the generic base kind — naming it adds nothing ("Create
  // Entity"), so it is suppressed in favour of the concrete profile slug.
  const noun =
    objectKind && objectKind.toLowerCase() !== "entity"
      ? resolveObjectNoun(objectKind)
      : "";
  const preposition = noun ? resolveActionPreposition(actionToken) : "";
  const head = [verb || "Proposal", preposition, noun]
    .filter(Boolean)
    .join(" ");
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
  // "Tool" / "Rule" are the user words (concepts.md, founder D1/D2).
  capability_run: "Run tool",
  automation_run: "Run rule",
  // Server-side dev-loop HUMAN GATES. The chip is the first thing a reviewer
  // reads, and the two gates ask genuinely different questions — one is about
  // work not yet done, one is about shipping work already verified — so they
  // get two chips, never one shared "Dev approval".
  dev_plan_approval: "Approve a plan",
  dev_deploy_approval: "Approve a deploy",
};

// ─── Tool kinds (one user word, the kind on the detail) ──────────────────────

/**
 * The KIND chip for something the user calls a "Tool" (concepts.md → Tools,
 * founder D2). Lists, counts and mentions say "Tool" (`resolveObjectNoun`);
 * a tool's own detail page shows WHICH kind of tool it is, with this.
 *
 * These are the three DB kinds behind the one word, named for what they are
 * to a user: a `skill` is instructions an agent follows, a `capability` is an
 * action the pod can run, a `tool` row is a connected integration (the
 * `tools` table holds integrations — CLAUDE.md "tools (integrations)").
 * Anything else humanizes; it is never "Tool", which would say nothing on a
 * page already titled as one.
 */
export const TOOL_KIND_LABELS: Readonly<Record<string, string>> = {
  skill: "Skill",
  capability: "Action",
  tool: "Integration",
};

export function resolveToolKindLabel(kind: string | null | undefined): string {
  if (!kind) return "";
  const key = kind.toLowerCase();
  const canonical = OBJECT_KIND_ALIASES[key] ?? key;
  return TOOL_KIND_LABELS[canonical] ?? humanizeToken(canonical);
}

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
  // The proposal's effect was taken back after approval. One word for the row's
  // status chip on every surface (the workbench and the phone both name it).
  reverted: "Reverted",
  // A write that landed with no decision in between (a person's own write, or
  // a legacy row with no receipt) — the `applied` state of a landed object
  // (`@synap-core/types/landed`), beside `approved` / `auto_approved`.
  applied: "Applied",
  // A landed object whose creating proposal the viewer cannot see
  // (`@synap-core/types/landed` `unknown`): nobody measured the decision FOR
  // THIS VIEWER, so it names no decision at all.
  unknown: "Unknown",
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
  // W2 calm: a run the reaper found past its window with its session still
  // owing the person an open slot (automation_runs / playbook_runs). Not
  // failed, not running — waiting on the human.
  waiting_on_you: "Waiting on you",
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
  // `not_connected` before resolving. `not_connected` is also the sync phase for
  // a sync with no live connection (`SyncPhase`), so one word covers both.
  // `disconnected` stays for tokens that already carry it.
  connected: "Connected",
  not_connected: "Not connected",
  disconnected: "Not connected",
  unavailable: "Not available",
  // tool demand (`tool_request.tr_status`): `installable` = the catalog now
  // covers a tool that was wanted. `wanted` needs no row (it humanizes to
  // "Wanted"); `connected` is shared with the row above.
  installable: "Ready to install",
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
  // session EVALUATION verdicts (`session_evaluations.verdict`, @synap-core/types
  // focus-sessions verdict). `unmeasured` is NOT a failure — nobody could check
  // it — so it must never read as one; "Not checked" says exactly that.
  pass: "Passed",
  fail: "Failed",
  unmeasured: "Not checked",
  // session VERDICT STATES — the whole session's grade over its criteria
  // (`computeSessionVerdict`, `SessionVerdictLike.state`), NOT a single
  // criterion's verdict above. They reached users through `humanizeToken`
  // ("Passing" / "Failing" / "Incomplete") until now.
  //
  // The words are chosen for work that is STILL IN FLIGHT, which is when this
  // label is read most: a session is graded while it runs, so "Failing" accused
  // work-in-progress of having failed when the truth is "not met yet". Each one
  // names the state of the CONTRACT, not a judgement of the person:
  //   passing    — every required criterion is met. "Met" matches the summary
  //                beside it ("All 4 met"), so the two cannot drift apart.
  //   failing    — a required criterion has a `fail` verdict. Still recoverable.
  //   incomplete — nothing failed; something has not been checked. "Partly
  //                checked" says exactly that, and never reads as a failure
  //                (the same rule `unmeasured: "Not checked"` follows).
  passing: "Met",
  failing: "Not yet met",
  incomplete: "Partly checked",
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
  // CAPTURE status — derived by `captures.list` / `captures.get`, never stored
  // (raw-capture contract §4). Spelled out because humanizing loses the words
  // that matter: `saved_without_ai` → "Saved without ai", and "Needs answer"
  // drops who owes it. "Saved without AI" is the one a person must spot.
  structured: "Structured",
  saved_without_ai: "Saved without AI",
  needs_answer: "Needs your answer",
  not_structured: "Not structured",
  // CONNECTION credential state (`secrets.connection_state`). Humanized it read
  // "Needs reauth" — jargon for "sign in again".
  needs_reauth: "Needs sign-in",
  // SHARING. `published` is `resource_shares.state` (`draft` is shared with the
  // run of drafts above). `revoked` is a link or publication killed for good
  // (0276: permanent). `private` / `shared` / `link` / `public` are the SHARE
  // STATE lenses `resolveShareState` (`@synap-core/types/units`) derives —
  // never stored. `link` reads "Shared by link" so a chip can never be taken
  // for the RELATION noun "Link" (`resolveObjectNoun("link")`).
  published: "Published",
  revoked: "Revoked",
  private: "Private",
  shared: "Shared",
  link: "Shared by link",
  public: "Public",
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
 * Where a capture came in — `documents.metadata.intakeSource.door`, as words.
 *
 * Keyed by the WHOLE door token. `humanizeToken` keeps only the last dotted
 * segment, which is exactly wrong here: `capture.graph` would read "Graph" and
 * `calcom.webhook` "Webhook" — the part that says WHERE is the prefix. Two
 * doors may share a label when a person cannot tell them apart (`capture` and
 * `capture.execute` are both "you captured it"; Cal.com live vs backfill).
 * `capture.graph` is "Agent or app": MCP agents AND Raycast/hub clients use it.
 * An unknown door humanizes, never leaks.
 */
export const CAPTURE_DOOR_LABELS: Readonly<Record<string, string>> = {
  capture: "Capture",
  "capture.execute": "Capture",
  "capture.graph": "Agent or app",
  "message.interpret": "Chat",
  "calcom.webhook": "Cal.com",
  "calcom.backfill": "Cal.com",
  import: "Import",
  structure_again: "Structure again",
};

export function resolveCaptureDoorLabel(
  door: string | null | undefined
): string {
  if (!door) return "";
  return CAPTURE_DOOR_LABELS[door.trim().toLowerCase()] ?? humanizeToken(door);
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
  // A stranger who filed through a public form (Sites W4). The proposal carries
  // the form's own actor as `agentUserId`, but NOBODY'S MODEL wrote it — so it
  // must never read "AI agent". The discriminator is the actor row
  // (`guestProvenanceFor` in the pod), never the display string.
  guest: "Guest",
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
 * SUBMISSION OUTCOME — what happens to a public form's submission, keyed by the
 * form's stored `mode` (`FormConfig.mode` in the pod, `"direct" | "proposal"`).
 *
 * Its OWN table: a mode is neither a lifecycle status (`STATUS_LABELS`) nor a
 * verb. It is the promise the owner reads when choosing a mode, and the mark a
 * reviewer reads on a submission: `proposal` → it waits for the owner;
 * `direct` → it became a record straight away. Humanized, the tokens would say
 * "Proposal" / "Direct" — the mechanism, not the consequence.
 *
 * The public REPLY never uses this: the anonymous door answers a constant 202
 * whatever the mode (W4, no oracle). This is owner-side vocabulary only.
 */
export const SUBMISSION_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  proposal: "Held for your review",
  direct: "Added immediately",
};

export function resolveSubmissionOutcomeLabel(
  mode: string | null | undefined
): string {
  if (!mode) return "";
  return SUBMISSION_OUTCOME_LABELS[mode.toLowerCase()] ?? humanizeToken(mode);
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

/**
 * The GLYPH for each blocked reason — `ui-composition.md` §1, "state is a MARK,
 * not a sentence": a reader knows what kind of obstacle it is before reading.
 *
 * Lucide icon NAMES (the `ObjectKindDef.icon` convention), never bound
 * components: relay (`lucide-react-native`) and the browser (`lucide-react`)
 * each resolve the name, so both draw the same mark from ONE table. Moved here
 * from relay's `owed-slot-detail.ts` so the browser does not grow a second map.
 *
 * TONE is deliberately NOT part of the mark: a blocker chip stays neutral and
 * the reason lives in its label + glyph, never in a colour (a missing
 * credential is not an error and not a warning).
 *
 * Same key set as {@link BLOCKED_REASON_LABELS}; the api parity tripwire
 * (`blocked-reason-vocabulary-parity.test.ts`) derives `BLOCKED_REASONS` and
 * fails if a value has no glyph here.
 */
export const BLOCKED_REASON_ICONS: Readonly<Record<string, string>> = {
  credential: "KeyRound",
  capability: "Plug",
  permission: "ShieldAlert",
  policy: "Scale",
  decision: "Gavel",
  physical: "Hand",
};

/** The glyph for a value that bypassed a door — never a row in the table. */
export const BLOCKED_REASON_FALLBACK_ICON = "CircleHelp";

/** The glyph NAME for a blocked reason; unknown/absent ⇒ the fallback mark. */
export function resolveBlockedReasonIcon(
  reason: string | null | undefined
): string {
  if (!reason) return BLOCKED_REASON_FALLBACK_ICON;
  return (
    BLOCKED_REASON_ICONS[reason.trim().toLowerCase()] ??
    BLOCKED_REASON_FALLBACK_ICON
  );
}

/**
 * COUNT NOUNS for what one session owes the person — the words of a needs-you
 * session card's summary ("2 decisions", "1 action · 1 decision").
 *
 * Keyed by the item's needs-you kind (`@synap-core/types/needs-you`
 * `needsYouItemKind`): an owed slot counts by its BLOCKED REASON (same keys as
 * {@link BLOCKED_REASON_LABELS}, but a countable noun, not a chip label —
 * "Human decision" is a label, "decision" is what you count), a draft's asks
 * as `ask`, a session awaiting acceptance as `review`, and an owed slot that
 * recorded no reason as `owed`. `[singular, plural]`, lower case: the noun
 * sits after a number, mid-phrase.
 */
export const NEEDS_YOU_ITEM_NOUNS: Readonly<
  Record<string, readonly [string, string]>
> = {
  decision: ["decision", "decisions"],
  physical: ["action", "actions"],
  credential: ["credential", "credentials"],
  permission: ["permission", "permissions"],
  capability: ["missing tool", "missing tools"],
  policy: ["policy block", "policy blocks"],
  ask: ["ask", "asks"],
  review: ["review", "reviews"],
  owed: ["thing", "things"],
};

/**
 * "<n> <noun>" for one needs-you item kind — singular at 1. An unknown kind
 * humanizes (lower-cased, plural by the fallback rule), never leaks.
 */
export function resolveNeedsYouItemCount(
  kind: string | null | undefined,
  n: number
): string {
  const key = (kind ?? "owed").trim().toLowerCase();
  const nouns = NEEDS_YOU_ITEM_NOUNS[key];
  if (nouns) return `${n} ${n === 1 ? nouns[0] : nouns[1]}`;
  const noun = humanizeToken(key).toLowerCase();
  return `${n} ${n === 1 ? noun : pluralizeFallback(noun)}`;
}

/**
 * NOTIFICATION-CATEGORY labels — the five buckets `notification_preferences`
 * and `NOTIFICATION_REGISTRY` sort every notification type into.
 *
 * ── Why this is here and not humanized at the call site ────────────────────
 * `humanizeToken("ai")` returns "Ai". That alone is the reason a curated row
 * is needed: the acronym is the one member the generic sentence-caser cannot
 * get right, and a call site that "fixes" it with its own `toUpperCase` is how
 * the six incompatible `humanizeKey` copies happened. The other four are
 * curated alongside it so the set reads as one taxonomy and a picker's group
 * headers can never half-agree.
 *
 * ── Why its own table ──────────────────────────────────────────────────────
 * These are not lifecycle states (`STATUS_LABELS`) and not object kinds
 * (`OBJECT_NOUNS`) — `data` and `system` would collide with both readings.
 * They are a closed classification of delivery, a different domain.
 *
 * The value set is defined ONCE, as `NotificationCategory` in
 * `@synap/database` (and mirrored by the `notification_category` PG enum).
 * This package is dependency-free by design and so mirrors the keys.
 */
export const NOTIFICATION_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  /** Proposals and AI requests awaiting a human. */
  governance: "Governance",
  /** Connector syncs and entity events. */
  data: "Data",
  /** Agent completions and skill triggers. NOT "Ai". */
  ai: "AI",
  /** Updates, errors, storage. */
  system: "System",
  /** External messages — Gmail, Slack, and the rest. */
  inbox: "Inbox",
};

/**
 * The human label for a notification category. Unknown values humanize rather
 * than leak, so a sixth category added to the PG enum can never reach a
 * settings screen as a raw token.
 */
export function resolveNotificationCategoryLabel(
  category: string | null | undefined
): string {
  if (!category) return "";
  return (
    NOTIFICATION_CATEGORY_LABELS[category.toLowerCase()] ??
    humanizeToken(category)
  );
}

/**
 * NOTIFICATION ROUTING-RULE labels — the values
 * `notification_preferences.routingRules` maps a notification type (or
 * category) onto, as a human choice in a settings picker.
 *
 * ── Why curated, not humanized ─────────────────────────────────────────────
 * `humanizeToken` gets two of the four wrong on its own: `in_app` → "In app"
 * and `os` → "Os". The same argument as the `ai` → "AI" row above, and the
 * same reason it belongs in this table rather than in a `charAt(0)` at the
 * call site.
 *
 * ── Why these words ────────────────────────────────────────────────────────
 * The labels name the DELIVERY the user gets, not the machine token's shape:
 * `os` is the channel that rings a phone, so "Push only" is what it means to
 * the person choosing it. `mute` is "Off" rather than "Muted" because the row
 * is never persisted at all — nothing arrives, not even in the bell.
 *
 * `telegram` is deliberately ABSENT. It is a legal `routingRules` value in the
 * type union but has no transport (`NotificationService.resolveChannels` logs
 * "not implemented" and falls back to defaults), so the catalogue never offers
 * it and no picker should render it. Leaving it out of this table is not an
 * omission: if one ever reaches a surface it humanizes to "Telegram", which is
 * honest, rather than being given a curated label that implies it works.
 */
export const NOTIFICATION_ROUTING_RULE_LABELS: Readonly<
  Record<string, string>
> = {
  /** Both delivering channels: the bell and a device push. */
  all: "In-app + Push",
  /** The `os` channel alone — what rings a phone. */
  os: "Push only",
  /** The bell alone; no device push. */
  in_app: "In-app only",
  /** Not persisted, not emitted, not pushed. */
  mute: "Off",
};

/**
 * The human label for a routing-rule value. Unknown values humanize rather
 * than leak, so `telegram` — or a sixth token added to the column's
 * vocabulary — can never reach a settings screen as a raw token.
 */
export function resolveNotificationRoutingRuleLabel(
  rule: string | null | undefined
): string {
  if (!rule) return "";
  return (
    NOTIFICATION_ROUTING_RULE_LABELS[rule.toLowerCase()] ?? humanizeToken(rule)
  );
}

// ─── Withheld objects (a reference the viewer may not open) ──────────────────

/**
 * The label for an object that EXISTS but that the viewer may not read — e.g. a
 * colleague's session named on a proposal or run the viewer can see (decision
 * D1, 2026-09-26: a session's title/goal is content). It replaces the title and
 * renders with no door; it never carries the object's name, goal or id.
 *
 *   "focus_session" → "Private session"
 *
 * The noun comes from {@link resolveObjectNoun}, so the placeholder can never
 * call the kind something the rest of the product does not. Its first letter
 * is lowered unless it opens an acronym ("API key" stays "API key").
 */
export function resolvePrivateObjectLabel(
  kind: string | null | undefined
): string {
  const noun = resolveObjectNoun(kind) || "item";
  const lowered = /^[A-Z]{2}/.test(noun)
    ? noun
    : noun.charAt(0).toLowerCase() + noun.slice(1);
  return `Private ${lowered}`;
}

/**
 * The mark on a proposal the viewer may SEE but not DECIDE because its subject
 * is an object only its members may read (founder decision 2026-09-27: nobody
 * decides what they cannot read — the pod's review reason `session-only`). A
 * CHIP label, never a sentence; it replaces the Approve / Reject buttons.
 *
 *   "focus_session" → "Session members decide"
 *
 * The noun comes from {@link resolveObjectNoun}, like the private placeholder.
 */
export function resolveMembersDecideLabel(
  kind: string | null | undefined
): string {
  const noun = resolveObjectNoun(kind) || "Item";
  return `${noun} members decide`;
}

// ─── Space brief fields (`SpaceBrief`, stored at settings.onboarding) ────────

/**
 * What a space brief's fields are CALLED wherever a person reads them (the
 * brief-edit proposal card, a brief editor). The storage keys are historical
 * (`framing`, `collect`, `anchors`) and humanize into words that mean nothing
 * to a reader ("Framing", "Collect"). Keyed by `keyof SpaceBrief`, so a new
 * brief field is a BUILD error here until it is named — never a raw token.
 */
export const SPACE_BRIEF_FIELD_LABELS: Readonly<
  Record<keyof SpaceBrief, string>
> = {
  purpose: "Purpose",
  goal: "Goal",
  framing: "Persona",
  expertise: "Expertise",
  collect: "Kinds to collect",
  openingQuestions: "Opening questions",
  doneWhen: "Done when",
  anchors: "Read first",
  rules: "Rules",
  fetch: "Where to look",
};

/** The label for a brief field; an unknown key humanizes rather than leaks. */
export function resolveSpaceBriefFieldLabel(
  field: string | null | undefined
): string {
  if (!field) return "";
  return (
    (SPACE_BRIEF_FIELD_LABELS as Readonly<Record<string, string>>)[field] ??
    humanizeToken(field)
  );
}

/**
 * The words of the TRUST LADDER (`@synap-core/types/trust-ladder`), in two
 * moods, like {@link ACTION_VERBS}:
 *
 *   - `name`  — what the rung IS, for a mark on a card or a Settings row
 *               ("Proposes").
 *   - `offer` — the next-rung button that moves work TO this rung, an
 *               imperative the person says ("Next time, do it and tell me").
 *
 * Keyed by `TrustRung`, so a new rung is a BUILD error here until it is named.
 * `ask` has an `offer` only for completeness: nothing climbs TO the lowest rung.
 */
export const TRUST_RUNG_LABELS: Readonly<
  Record<TrustRung, { name: string; offer: string }>
> = {
  ask: { name: "Asks you", offer: "Ask me first" },
  propose: { name: "Proposes", offer: "Next time, prepare it for me to decide" },
  do_tell: { name: "Does it, tells you", offer: "Next time, do it and tell me" },
  quiet: { name: "Just does it", offer: "Always let it do this" },
};

/** A rung's words in one mood; an unknown rung humanizes rather than leaks. */
export function resolveTrustRungLabel(
  rung: string | null | undefined,
  mood: "name" | "offer" = "name"
): string {
  if (!rung) return "";
  const row = (
    TRUST_RUNG_LABELS as Readonly<
      Record<string, { name: string; offer: string }>
    >
  )[rung];
  return row ? row[mood] : humanizeToken(rung);
}
