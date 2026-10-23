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
 */

import { isAppPublicId } from "@synap-core/types/membrane";
import { FIRST_PARTY_CLIENT_NAMES } from "@synap-core/types/vocabulary";

export interface OfferedSpace {
  workspaceId: string;
  workspaceName: string;
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
 * What starts ticked: the person's current approval for this app (a
 * re-consent), within today's offer. On a first consent, a permission with
 * exactly ONE space on offer starts ticked; with several, none do (the person
 * picks), unless `spaceHint` names one of them.
 *
 * `spaceHint` is the launch's `space_hint` (the Synap browser opened the app
 * from that space). It is untrusted query text: it only pre-ticks a space the
 * offer already holds, never on a re-consent, and never reaches the server.
 */
export function initialSelection(
  offer: readonly OfferedPermission[],
  current: readonly ApprovedPair[],
  spaceHint?: string | null
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
    const hinted = spaceHint
      ? o.workspaces.find((w) => w.workspaceId === spaceHint)
      : undefined;
    if (hinted) {
      out.add(key(o.permission, hinted.workspaceId));
    } else if (o.workspaces.length === 1) {
      out.add(key(o.permission, o.workspaces[0]!.workspaceId));
    }
  }
  return out;
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
  return "Pick at least one space.";
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
 * it". The raw permission is shown beside it, so an unusual one is never
 * hidden behind a friendly word.
 */
export function permissionLabel(permission: string): string {
  const segs = permission.split(".");
  const action = segs[segs.length - 1] ?? "";
  const verb = ACTION_WORDS[action] ?? action;
  const subject = segs[0] ?? "";
  const kind = segs.length > 2 ? segs[1] : null;
  if (subject === "entity") {
    if (!kind || kind === "*") return `${verb} everything in it`;
    return `${verb} ${plural(kind.replace(/[_-]/g, " "))}`;
  }
  const noun = kind && kind !== "*" ? `${subject} ${kind}` : subject;
  return `${verb} ${plural(noun.replace(/[_-]/g, " "))}`;
}
