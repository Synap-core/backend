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

export interface OfferedSpace {
  workspaceId: string;
  workspaceName: string;
}

export interface OfferedPermission {
  permission: string;
  workspaces: OfferedSpace[];
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
 * exactly ONE space on offer starts ticked; with several, none do — the person
 * picks.
 */
export function initialSelection(
  offer: readonly OfferedPermission[],
  current: readonly ApprovedPair[]
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
    if (o.workspaces.length === 1) {
      out.add(key(o.permission, o.workspaces[0]!.workspaceId));
    }
  }
  return out;
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
