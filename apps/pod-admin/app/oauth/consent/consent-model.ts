/**
 * The pod app consent screen's selection model (spec 17 §9.1) — pure, so the
 * narrow-only rule is tested without a browser.
 *
 * The server sends the OFFER: each permission the app asked for, with the
 * spaces this person may give it in. The person ticks a subset. Nothing here
 * can add a pair the offer does not hold: `toggle` ignores one, and
 * `toApproved` filters to the offer again before anything is sent. The server
 * re-derives the offer and refuses a wider selection anyway
 * (`connectOAuthApp`); this keeps the screen honest about what Allow sends.
 *
 * A DECISION permission (any grant-grammar gate verb, `GRANT_GATE_ACTIONS`:
 * `proposal.approve`, `entity.post.archive`, …) is never folded into a write:
 * the screen shows it in its own row and section (`groupByObject`,
 * `splitOffer`), and a first consent pre-ticks it only if
 * `PRESELECT_DECISIONS` says so.
 *
 * The screen reads OBJECT-FIRST (founder, 2026-10-23): one row per object the
 * app may edit, every object it only views folded into ONE row "It can also
 * see" (`groupByObject`), each at one level (`objectLevel`: Edit, View or
 * Off) in the spaces made from the app's declared templates
 * (`defaultSpaces`). "Customize…" shows the full permission × space matrix.
 * Both edit the ONE selection below; nothing new is sent on the wire.
 */

import {
  GRANT_ACTIONS,
  GRANT_GATE_ACTIONS,
  grantActionLabel,
  grantKindLabel,
  grantSubjectLabel,
  isQualifiedGrantSubject,
  parsePermission,
} from "@synap-core/types/grants";
import { isAppPublicId } from "@synap-core/types/membrane";
import { FIRST_PARTY_CLIENT_NAMES } from "@synap-core/types/vocabulary";
import { patternMatches } from "@synap/governance-policy/grants";
import type { ReceiverWidth } from "../../_lib/receiver-shell";

export interface OfferedSpace {
  workspaceId: string;
  workspaceName: string;
  /**
   * The template the space was made from (`oauthAppOffer`), or null. A space
   * from one of the app's declared templates starts ticked; it never changes
   * what is on offer.
   */
  templateSlug?: string | null;
}

export interface OfferedPermission {
  permission: string;
  workspaces: OfferedSpace[];
  /**
   * The developer's own reason for asking (`synap_requests[].reason`, required
   * by the kit's `synap:check`). Absent until the pod stores and sends it.
   * Self-chosen text: shown as text, never as markup, and never as a reason
   * to trust the app.
   */
  reason?: string | null;
}

export interface ApprovedPair {
  permission: string;
  workspaceId: string;
}

/** The ticked pairs, keyed `permission\u0000workspaceId`. */
export type Selection = ReadonlySet<string>;

const key = (permission: string, workspaceId: string) =>
  `${permission}\u0000${workspaceId}`;

/**
 * The permission's verb is a gate verb (approve, reject, archive, merge,
 * transition, …: `GRANT_GATE_ACTIONS`), not a write. Each is a decision the
 * person gives on its own (#94, #133); Edit never includes one.
 */
export function isDecisionPermission(permission: string): boolean {
  const action = permission.split(".").pop() ?? "";
  return (GRANT_GATE_ACTIONS as readonly string[]).includes(action);
}

/** The permission only reads (`…read`); a bare subject or kind is a write. */
export function isReadOnlyPermission(permission: string): boolean {
  return parts(permission).action === "read";
}

/**
 * A permission's object and verb: `entity.post.read` → object `entity.post`,
 * kind `post`, action `read`; `entity.read` → kind `*`; `document.update` →
 * object `document`; a bare `entity.post` or `proposal` → action null (it
 * grants read, create, update and delete).
 */
function parts(permission: string): {
  object: string;
  subject: string;
  kind: string | null;
  action: string | null;
} {
  let segs: string[];
  try {
    segs = parsePermission(permission);
  } catch {
    segs = permission.split(".");
  }
  const subject = segs[0] ?? "";
  const verbs: readonly string[] = [...GRANT_ACTIONS, ...GRANT_GATE_ACTIONS];
  const last = segs.length > 1 ? (segs[segs.length - 1] ?? null) : null;
  const action = last !== null && verbs.includes(last) ? last : null;
  const rest = action === null ? segs.slice(1) : segs.slice(1, -1);
  if (isQualifiedGrantSubject(subject)) {
    const kind = rest[0] ?? "*";
    return { object: `${subject}.${kind}`, subject, kind, action };
  }
  return {
    object: [subject, ...rest].join("."),
    subject,
    kind: null,
    action,
  };
}

/** The offer as the screen lists it: reads and writes, then decisions apart. */
export function splitOffer(offer: readonly OfferedPermission[]): {
  grants: OfferedPermission[];
  decisions: OfferedPermission[];
} {
  return {
    grants: offer.filter((o) => !isDecisionPermission(o.permission)),
    decisions: offer.filter((o) => isDecisionPermission(o.permission)),
  };
}

function offered(
  offer: readonly OfferedPermission[],
  permission: string,
  workspaceId: string
): boolean {
  return offer.some(
    (o) =>
      o.permission === permission &&
      o.workspaces.some((w) => w.workspaceId === workspaceId)
  );
}

/**
 * Whether a first consent pre-ticks a decision permission (approve / reject).
 * `false`: letting an app decide for you is a different kind of grant from a
 * read or a write, so the person ticks it themselves (#94's review, commit
 * 05a3a3d3f). The founder may override it: this is the one place it is set.
 */
export const PRESELECT_DECISIONS = false;

/**
 * A permission's DEFAULT spaces: the offered spaces made from one of the
 * app's declared templates (`synap_templates`). When the app declared none,
 * or the person has no such space for this permission, every offered space
 * (#133). Always a subset of the offer.
 */
export function defaultSpaces(
  item: OfferedPermission,
  templates: readonly string[]
): OfferedSpace[] {
  const fromTemplate = item.workspaces.filter(
    (w) => !!w.templateSlug && templates.includes(w.templateSlug)
  );
  return fromTemplate.length > 0 ? fromTemplate : [...item.workspaces];
}

/**
 * What starts ticked. A first consent: everything the app asks for, in its
 * default spaces (`defaultSpaces`: the spaces from its declared templates,
 * else every space on offer); the person narrows or widens from there. A
 * decision permission only if `PRESELECT_DECISIONS`.
 *
 * A re-consent: exactly the person's current approval, within today's offer.
 * Nothing new is ticked for them, because the pod keeps what they approved,
 * not what they were asked: a pair missing from it may be a new ask or one
 * they unticked last time, and re-ticking a "no" is not theirs to have made.
 *
 * The launch's `space_hint` is not an input: it orders (`spaceHintFirst`),
 * it never ticks.
 */
export function initialSelection(
  offer: readonly OfferedPermission[],
  current: readonly ApprovedPair[],
  templates: readonly string[] = []
): Selection {
  const out = new Set<string>();
  if (current.length > 0) {
    for (const c of current) {
      if (offered(offer, c.permission, c.workspaceId)) {
        out.add(key(c.permission, c.workspaceId));
      }
    }
    return out;
  }
  for (const o of offer) {
    if (!PRESELECT_DECISIONS && isDecisionPermission(o.permission)) continue;
    for (const w of defaultSpaces(o, templates)) {
      out.add(key(o.permission, w.workspaceId));
    }
  }
  return out;
}

/**
 * The offer with the launch's space (`space_hint`: the Synap browser opened
 * the app from it) listed first under each permission that offers it. Order
 * only: it never adds a space a permission does not offer, and an unknown or
 * absent hint leaves the offer as it is. The hint is untrusted query text and
 * never reaches the server.
 */
export function spaceHintFirst<T extends OfferedPermission>(
  offer: readonly T[],
  spaceHint?: string | null
): T[] {
  if (!spaceHint) return [...offer];
  return offer.map((o) => {
    const hinted = o.workspaces.find((w) => w.workspaceId === spaceHint);
    if (!hinted) return o;
    return {
      ...o,
      workspaces: [hinted, ...o.workspaces.filter((w) => w !== hinted)],
    };
  });
}

/** How much of a section is ticked: drives its one tri-state checkbox. */
export type SectionState = "all" | "some" | "none";

/**
 * A section (the reads and writes, or the decisions: `splitOffer`) ticked in
 * full, in part, or not at all, over the spaces it is offered in. A section
 * with no space to give reads "none".
 */
export function sectionState(
  selection: Selection,
  section: readonly OfferedPermission[]
): SectionState {
  let total = 0;
  let ticked = 0;
  for (const o of section) {
    for (const w of o.workspaces) {
      total += 1;
      if (selection.has(key(o.permission, w.workspaceId))) ticked += 1;
    }
  }
  if (ticked === 0) return "none";
  return ticked === total ? "all" : "some";
}

/**
 * The section checkbox pressed: all ticked → none; some or none → all. Like
 * `toggle`, it never adds a pair the offer does not hold.
 */
export function toggleSection(
  selection: Selection,
  offer: readonly OfferedPermission[],
  section: readonly OfferedPermission[]
): Selection {
  const tick = sectionState(selection, section) !== "all";
  const next = new Set(selection);
  for (const o of section) {
    for (const w of o.workspaces) {
      const k = key(o.permission, w.workspaceId);
      if (!tick) next.delete(k);
      else if (offered(offer, o.permission, w.workspaceId)) next.add(k);
    }
  }
  return next;
}

/**
 * A section checkbox's accessible name: what it selects, starting with its
 * visible label ("All") so a voice user can say what they see.
 */
export function sectionCheckboxLabel(section: "grants" | "decisions"): string {
  return section === "grants"
    ? "All it asks to do, in every space"
    : "All its decisions, in every space";
}

/**
 * Why Allow is disabled, said next to it, or null when it may be pressed.
 * A disabled button with no reason reads as a broken page.
 */
export function allowBlockedReason(
  offer: readonly OfferedPermission[],
  selection: Selection
): string | null {
  if (toApproved(selection, offer).length > 0) return null;
  if (offer.every((o) => o.workspaces.length === 0)) {
    return "You have no space to give it yet.";
  }
  return "Turn on at least one thing it asks for.";
}

/**
 * A space checkbox's accessible name. The visible label is the space alone,
 * which repeats under every permission ("Brand, Brand, Brand"); a screen
 * reader needs which permission it gives there.
 */
export function spaceCheckboxLabel(permission: string, space: string): string {
  return `${permissionLabel(permission)} in ${space}`;
}

/** The developer's reason for a permission, trimmed, or null when none was sent. */
export function reasonOf(item: OfferedPermission): string | null {
  const r = item.reason?.trim();
  return r ? r : null;
}

/**
 * Which kind of client a consent request is for, read from the query's
 * `client_id` alone. Used only when the request could not be resolved, so the
 * recovery hint fits where the person came from: a pod app names its metadata
 * document by URL, a "Sign in with Synap" app by its `app_` public id, a Synap
 * app (desktop, Relay) by its registered id, and anything else is an MCP
 * client (claude.ai) that registered itself.
 */
export type ConsentClientKind = "pod_app" | "sign_in" | "first_party" | "mcp";

export function consentClientKind(clientId: string): ConsentClientKind {
  // The pod's own rule (`isClientMetadataUrl`): any URL-shaped client_id.
  if (/^[a-z][a-z0-9+.-]*:/i.test(clientId)) return "pod_app";
  if (isAppPublicId(clientId)) return "sign_in";
  if (Object.hasOwn(FIRST_PARTY_CLIENT_NAMES, clientId)) return "first_party";
  return "mcp";
}

/**
 * The consent card's width, from the request alone so it never jumps once
 * the offer loads: a pod app lists every permission × space it asks for and
 * reads wider (`md`, founder 2026-10-23); every other consent is one decision.
 */
export function consentWidth(clientId: string): ReceiverWidth {
  return consentClientKind(clientId) === "pod_app" ? "md" : "sm";
}

/** The recovery step under "This authorization request isn't valid". */
export function invalidRequestHint(clientId: string): string {
  switch (consentClientKind(clientId)) {
    case "pod_app":
      return "Close this tab, go back to the app's website and connect again. A fresh request will carry valid details.";
    case "sign_in":
      return "Close this tab, go back to the app and sign in again. A fresh request will carry valid details.";
    case "first_party":
      return `Close this tab and sign in again from ${FIRST_PARTY_CLIENT_NAMES[clientId]}. A fresh request will carry valid details.`;
    case "mcp":
      return "Close this tab and start the connection again from Claude. A fresh request will carry valid details.";
  }
}

/** Tick or untick one pair. A pair the offer does not hold is never added. */
export function toggle(
  selection: Selection,
  offer: readonly OfferedPermission[],
  permission: string,
  workspaceId: string
): Selection {
  const k = key(permission, workspaceId);
  const next = new Set(selection);
  if (next.has(k)) {
    next.delete(k);
  } else if (offered(offer, permission, workspaceId)) {
    next.add(k);
  }
  return next;
}

export function isTicked(
  selection: Selection,
  permission: string,
  workspaceId: string
): boolean {
  return selection.has(key(permission, workspaceId));
}

/** What Allow sends: the ticked pairs, filtered to the offer, in offer order. */
export function toApproved(
  selection: Selection,
  offer: readonly OfferedPermission[]
): ApprovedPair[] {
  const out: ApprovedPair[] = [];
  for (const o of offer) {
    for (const w of o.workspaces) {
      if (selection.has(key(o.permission, w.workspaceId))) {
        out.push({ permission: o.permission, workspaceId: w.workspaceId });
      }
    }
  }
  return out;
}

/**
 * The line under the space choice when the app may read records (rv-ui U1).
 * A space grant reads what a member of the space reads (founder "option 1",
 * 2026-10-23): what is stored there, plus any record of the pod with a role
 * there (a pod-wide person or company, or a record of another space).
 */
export const SPACE_REACH_NOTE =
  "It sees what a member of these spaces sees: what is stored there, plus the people, companies and other records of your pod that have a role there. Nothing else in your pod.";

/**
 * Whether any permission on offer reads records (entities) of ANY kind: the
 * reach has no kind limit, so a posts-only reader reaches roled posts too
 * (rv-ui U3).
 */
export function readsSpaceRecords(
  offer: readonly OfferedPermission[]
): boolean {
  return offer.some(({ permission }) => {
    try {
      // The pattern's own kind, so a kind-specific read counts for that kind.
      const kind = parsePermission(permission)[1];
      return patternMatches(permission, {
        subject: "entity",
        qualifier: kind && kind !== "*" ? kind : "any",
        action: "read",
      });
    } catch {
      return false; // a malformed pattern grants nothing
    }
  });
}

/**
 * A Synap app's headline: the server's `lead` ("Content Studio will act as
 * you in") ended with the spaces ticked — the grant the token will carry, so
 * the sentence changes as the person ticks: "…: Content OS, Ecosystem.".
 */
export function actsAsHeadline(
  lead: string,
  selection: Selection,
  offer: readonly OfferedPermission[]
): string {
  const names: string[] = [];
  for (const o of offer) {
    for (const w of o.workspaces) {
      if (
        selection.has(key(o.permission, w.workspaceId)) &&
        !names.includes(w.workspaceName)
      ) {
        names.push(w.workspaceName);
      }
    }
  }
  return names.length > 0
    ? `${lead}: ${names.join(", ")}.`
    : `${lead} the spaces you choose below.`;
}

/** The permissions the person has NO space to give in. */
export function withoutSpace(
  offer: readonly OfferedPermission[]
): OfferedPermission[] {
  return offer.filter((o) => o.workspaces.length === 0);
}

const ACTION_WORDS: Record<string, string> = {
  read: "Read",
  create: "Create",
  update: "Edit",
  delete: "Delete",
};

const plural = (word: string) =>
  word.endsWith("s")
    ? word
    : word.endsWith("y")
      ? `${word.slice(0, -1)}ies`
      : `${word}s`;

/**
 * A plain-language line for a grant-grammar permission
 * (`<subject>[.<kind>].<action>`): `entity.post.create` → "Create posts",
 * `document.update` → "Edit documents", `entity.read` → "Read everything in
 * it", `proposal.approve` → "Approve changes waiting for your review",
 * `entity.post.archive` → "Archive posts". The
 * raw permission is shown beside it, so an unusual one is never
 * hidden behind a friendly word.
 */
export function permissionLabel(permission: string): string {
  const segs = permission.split(".");
  const action = segs[segs.length - 1] ?? "";
  if (segs[0] === "proposal" && isDecisionPermission(permission)) {
    return `${grantActionLabel(action)} changes waiting for your review`;
  }
  // A gate verb (archive, merge, …) in the vocabulary's words.
  const verb = ACTION_WORDS[action] ?? grantActionLabel(action);
  const subject = segs[0] ?? "";
  const kind = segs.length > 2 ? segs[1] : null;
  if (subject === "entity") {
    if (!kind || kind === "*") return `${verb} everything in it`;
    return `${verb} ${plural(kind.replace(/[_-]/g, " "))}`;
  }
  const noun = kind && kind !== "*" ? `${subject} ${kind}` : subject;
  return `${verb} ${plural(noun.replace(/[_-]/g, " "))}`;
}

// ─── Object-first rows ───────────────────────────────────────────────────────

/** A row's one level: what the app may do with that object. */
export type AccessLevel = "off" | "view" | "edit" | "on";

/** The words on a level's segment. */
export const LEVEL_WORDS: Record<AccessLevel, string> = {
  off: "Off",
  view: "View",
  edit: "Edit",
  on: "On",
};

/** "Changes waiting for your review": what `proposal.*` reads as. */
const REVIEW_QUEUE = "Changes waiting for your review";

/** One object the app asks about, and every permission it asks on it. */
export interface ConsentObject {
  /**
   * `entity.post`, `document`, …; `decisions` for the gate verbs;
   * `also-see` for the folded read-only objects.
   */
  key: string;
  /** The object's name, from the grants' vocabulary door. */
  label: string;
  /** The kind, for an `entity.<kind>` row; null otherwise. */
  kind: string | null;
  /** The "decide for you" row (every gate verb), Off unless given. */
  decisions: boolean;
  /** The levels its control offers, lowest first: Off, then View / Edit. */
  levels: AccessLevel[];
  /** Every permission of the row (of all its members, when folded). */
  permissions: OfferedPermission[];
  /**
   * The objects folded into "It can also see", each its own row (View or
   * Off, its own spaces); empty on every other row.
   */
  members: ConsentObject[];
}

const isWrite = (permission: string) =>
  !isDecisionPermission(permission) && !isReadOnlyPermission(permission);

/** The folded row's key and name. */
export const ALSO_SEE = "also-see";
const ALSO_SEE_LABEL = "It can also see";

/**
 * The offer as rows: one per object the app may edit (`entity.<kind>.*` →
 * that kind, `document.*` → Documents, …), in offer order; then every object
 * it only views (`proposal.read` → changes waiting for review, …) folded into
 * ONE row "It can also see" (`members`, founder 2026-10-23: understood at a
 * glance); then every decision (each gate verb) in ONE last row.
 */
export function groupByObject(
  offer: readonly OfferedPermission[]
): ConsentObject[] {
  const rows = objectRows(offer);
  const edits = rows.filter((r) => !r.decisions && r.levels.includes("edit"));
  const views = rows.filter((r) => !r.decisions && !r.levels.includes("edit"));
  const decide = rows.filter((r) => r.decisions);
  const folded: ConsentObject[] =
    views.length > 0
      ? [
          {
            key: ALSO_SEE,
            label: ALSO_SEE_LABEL,
            kind: null,
            decisions: false,
            levels: ["off", "view"],
            permissions: views.flatMap((r) => r.permissions),
            members: views,
          },
        ]
      : [];
  return [...edits, ...folded, ...decide];
}

/** One row per object, each with the levels its permissions allow. */
function objectRows(offer: readonly OfferedPermission[]): ConsentObject[] {
  const rows = new Map<string, ConsentObject>();
  for (const o of offer) {
    const decision = isDecisionPermission(o.permission);
    const p = parts(o.permission);
    const rowKey = decision ? "decisions" : p.object;
    let row = rows.get(rowKey);
    if (!row) {
      row = {
        key: rowKey,
        label: decision
          ? "Decide for you"
          : p.subject === "proposal"
            ? REVIEW_QUEUE
            : p.kind === "*"
              ? "Everything"
              : p.kind
                ? grantKindLabel(p.kind)
                : grantSubjectLabel(p.subject),
        kind: decision || p.kind === "*" ? null : p.kind,
        decisions: decision,
        levels: [],
        permissions: [],
        members: [],
      };
      rows.set(rowKey, row);
    }
    row.permissions.push(o);
  }
  const out = [...rows.values()];
  for (const row of out) {
    row.levels = row.decisions
      ? ["off", "on"]
      : [
          "off",
          ...(row.permissions.some((o) => isReadOnlyPermission(o.permission))
            ? (["view"] as const)
            : []),
          ...(row.permissions.some((o) => isWrite(o.permission))
            ? (["edit"] as const)
            : []),
        ];
  }
  return out;
}

/** The permissions a level gives on a row. */
function givesAt(level: AccessLevel, permission: string): boolean {
  if (level === "on") return isDecisionPermission(permission);
  if (level === "edit") return !isDecisionPermission(permission);
  if (level === "view") return isReadOnlyPermission(permission);
  return false;
}

/**
 * A row's level, read from the selection: Edit when any write is ticked,
 * View when only reads are, On for a decision ticked anywhere, else Off.
 */
export function objectLevel(
  selection: Selection,
  row: ConsentObject
): AccessLevel {
  let read = false;
  for (const o of row.permissions) {
    for (const w of o.workspaces) {
      if (!selection.has(key(o.permission, w.workspaceId))) continue;
      if (row.decisions) return "on";
      if (isWrite(o.permission)) return "edit";
      read = true;
    }
  }
  return read ? "view" : "off";
}

/** The spaces a row holds at least one ticked pair in, in offer order. */
export function objectSpaces(
  selection: Selection,
  row: ConsentObject
): OfferedSpace[] {
  const out: OfferedSpace[] = [];
  for (const o of row.permissions) {
    for (const w of o.workspaces) {
      if (
        selection.has(key(o.permission, w.workspaceId)) &&
        !out.some((s) => s.workspaceId === w.workspaceId)
      ) {
        out.push(w);
      }
    }
  }
  return out;
}

/**
 * The spaces a row shows a tick for: the ones it holds, then its default
 * spaces. Every other space it is offered in sits behind "Also allow in
 * another space…" (`otherSpaces`).
 */
export function shownSpaces(
  selection: Selection,
  row: ConsentObject,
  templates: readonly string[]
): OfferedSpace[] {
  const out = objectSpaces(selection, row);
  for (const o of row.permissions) {
    for (const w of defaultSpaces(o, templates)) {
      if (!out.some((s) => s.workspaceId === w.workspaceId)) out.push(w);
    }
  }
  return out;
}

/** The spaces a row is offered in that `shownSpaces` leaves out. */
export function otherSpaces(
  selection: Selection,
  row: ConsentObject,
  templates: readonly string[]
): OfferedSpace[] {
  const shown = shownSpaces(selection, row, templates);
  const out: OfferedSpace[] = [];
  for (const o of row.permissions) {
    for (const w of o.workspaces) {
      if (
        !shown.some((s) => s.workspaceId === w.workspaceId) &&
        !out.some((s) => s.workspaceId === w.workspaceId)
      ) {
        out.push(w);
      }
    }
  }
  return out;
}

/**
 * The level control pressed. Off clears exactly this row's pairs. View or
 * Edit (On for decisions) gives the row's permissions at that level in the
 * spaces the row already holds, or, from Off, in each permission's default
 * spaces. Like `toggle`, it never adds a pair the offer does not hold.
 */
export function setObjectLevel(
  selection: Selection,
  offer: readonly OfferedPermission[],
  row: ConsentObject,
  level: AccessLevel,
  templates: readonly string[]
): Selection {
  const held = new Set(objectSpaces(selection, row).map((s) => s.workspaceId));
  const next = new Set(selection);
  for (const o of row.permissions) {
    for (const w of o.workspaces) next.delete(key(o.permission, w.workspaceId));
  }
  for (const o of row.permissions) {
    if (!givesAt(level, o.permission)) continue;
    const spaces =
      held.size > 0
        ? o.workspaces.filter((w) => held.has(w.workspaceId))
        : defaultSpaces(o, templates);
    for (const w of spaces) {
      if (offered(offer, o.permission, w.workspaceId)) {
        next.add(key(o.permission, w.workspaceId));
      }
    }
  }
  return next;
}

/**
 * A row's space tick pressed. Held there → every pair of the row in that
 * space is cleared. Not held → the row's level is given there (from Off, its
 * lowest level: View, or Edit when it only writes, or On). Narrow-only.
 */
export function toggleObjectSpace(
  selection: Selection,
  offer: readonly OfferedPermission[],
  row: ConsentObject,
  workspaceId: string
): Selection {
  const next = new Set(selection);
  const held = row.permissions.some((o) =>
    selection.has(key(o.permission, workspaceId))
  );
  if (held) {
    for (const o of row.permissions)
      next.delete(key(o.permission, workspaceId));
    return next;
  }
  const current = objectLevel(selection, row);
  const level = current === "off" ? (row.levels[1] ?? "off") : current;
  for (const o of row.permissions) {
    if (
      givesAt(level, o.permission) &&
      offered(offer, o.permission, workspaceId)
    ) {
      next.add(key(o.permission, workspaceId));
    }
  }
  return next;
}

/** A row holds at least one pair in this space. */
export function holdsSpace(
  selection: Selection,
  row: ConsentObject,
  workspaceId: string
): boolean {
  return row.permissions.some((o) =>
    selection.has(key(o.permission, workspaceId))
  );
}

/**
 * Where a row is given, in words: "in Content OS", "in Content OS and
 * Ecosystem", "in Brand, Builder and Content OS", "in Brand, Builder and 3
 * more spaces". Null when it is given nowhere (its control says Off).
 */
export function scopeLabel(spaces: readonly OfferedSpace[]): string | null {
  const names = spaces.map((s) => s.workspaceName);
  if (names.length === 0) return null;
  if (names.length === 1) return `in ${names[0]}`;
  if (names.length <= 3) {
    return `in ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `in ${names.slice(0, 2).join(", ")} and ${names.length - 2} more spaces`;
}

/** The level control's accessible name: what it sets, for which object. */
export function levelControlLabel(row: ConsentObject): string {
  return row.decisions ? "Let it decide for you" : `${row.label}: access`;
}

/** A row's space tick's accessible name: the object AND the space. */
export function objectSpaceLabel(row: ConsentObject, space: string): string {
  return `${row.label} in ${space}`;
}

/** "A", "A or B", "A, B or C". */
const orList = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;

/**
 * Under "Decide for you" while it is Off: each gate verb it asks, in words,
 * once ("Approve or reject a change waiting for your review, as you";
 * "Approve, reject or archive, as you"). Its detail names each permission.
 */
export function decideLine(row: ConsentObject): string {
  const verbs: string[] = [];
  for (const o of row.permissions) {
    const word = grantActionLabel(
      o.permission.split(".").pop() ?? ""
    ).toLowerCase();
    if (!verbs.includes(word)) verbs.push(word);
  }
  const said = orList(verbs);
  const line = `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
  return row.permissions.every((o) => o.permission.startsWith("proposal."))
    ? `${line} a change waiting for your review, as you`
    : `${line}, as you`;
}

/**
 * Under "It can also see": the objects it is given, by name, the first four
 * then "+N more" ("Pillars, Journey stages, Series, Platforms +7 more").
 * While the row is Off, the objects it asks to see.
 */
export function alsoSeeLine(selection: Selection, row: ConsentObject): string {
  const given = row.members.filter((m) => objectLevel(selection, m) !== "off");
  const names = (given.length > 0 ? given : row.members).map((m) => m.label);
  return names.length <= 4
    ? names.join(", ")
    : `${names.slice(0, 4).join(", ")} +${names.length - 4} more`;
}

/**
 * A pod-wide kind's note (SDK 1.5.1 reach rule): such an entity is in no
 * single space, so the app reaches it only through a role in a space it was
 * given. Grants stay (permission, space) pairs; nothing here is pod-wide.
 */
export function podWideNote(row: ConsentObject): string {
  return `${row.label} kept across your whole pod, not in one space, reach it only through a role in a space you give it.`;
}
