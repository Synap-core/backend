/**
 * Changing what an existing key may do (pod admin, Keys drawer): the pure half.
 * The door is `apiKeys.setGrants` (signed-in owner only; it REPLACES the key's
 * grant set, never edits one). Every rule about a grant is the shared model in
 * `@synap-core/types/grants`; this file only decides who is offered the door,
 * what the editor starts from, what it sends and what changed, in words.
 *
 * The editor starts from `apiKeys.list`, the owner's own read of the key: its
 * grants there carry the narrowing and the role lineage (`roleId`) that
 * `setGrants` must send back, and a key that is not in that list is not the
 * viewer's to change.
 */

import {
  draftToGrantInput,
  grantToDraft,
  validateGrantDraft,
  type GrantDraft,
  type KeyAccessGrant,
  type ListedGrantDraft,
} from "@synap-core/types/grants";
import { permissionLabel } from "../../../oauth/consent/consent-model";
import type { UnifiedKey } from "./key-model";

/** A key as `apiKeys.list` returns it (the viewer's own, and their agents'). */
export interface ListedKey extends Pick<
  UnifiedKey,
  "isActive" | "keyType" | "holder" | "expiresAt" | "revokedAt"
> {
  readonly id: string;
  readonly grants: readonly KeyAccessGrant[];
}

/**
 * Who is offered the door, as the server decides it:
 *  - `not-yours`: not in the viewer's own list (the server answers NOT_FOUND);
 *  - `ended`: revoked, switched off or expired (nothing to change);
 *  - `app`: an app's key is changed on the app's page;
 *  - `edit`: the grants to start from.
 */
export type KeyEditDoor =
  | { readonly kind: "not-yours" }
  | { readonly kind: "ended" }
  | { readonly kind: "app" }
  | { readonly kind: "edit"; readonly drafts: ListedGrantDraft[] };

export function keyEditDoor(
  listed: ListedKey | undefined,
  now: number = Date.now()
): KeyEditDoor {
  if (!listed) return { kind: "not-yours" };
  const expired =
    listed.expiresAt != null && new Date(listed.expiresAt).getTime() <= now;
  if (!listed.isActive || listed.revokedAt || expired) return { kind: "ended" };
  if (listed.holder?.kind === "app" || listed.keyType === "app_person")
    return { kind: "app" };
  return { kind: "edit", drafts: draftsOfKey(listed) };
}

/** The grants to edit; a key with none starts from one empty grant. */
export function draftsOfKey(listed: {
  readonly grants: readonly KeyAccessGrant[];
}): ListedGrantDraft[] {
  return listed.grants.length > 0
    ? listed.grants.map(grantToDraft)
    : [{ permissions: [] }];
}

/** The `apiKeys.setGrants` `grants` for these drafts (lifetime is the key's). */
export function setGrantsInput(drafts: readonly ListedGrantDraft[]) {
  return drafts.map(draftToGrantInput);
}

/** Can this be sent? Every grant keeps at least one valid permission. */
export function editProblems(drafts: readonly GrantDraft[]): {
  readonly empty: boolean;
  readonly invalid: string[];
} {
  const empty = drafts.some((d) => d.permissions.length === 0);
  const invalid: string[] = [];
  for (const d of drafts) {
    if (d.permissions.length === 0) continue;
    const v = validateGrantDraft(d);
    if (!v.ok)
      for (const p of v.problems)
        if ("message" in p && typeof p.message === "string")
          invalid.push(p.message);
  }
  return { empty, invalid };
}

export interface KeyEditChange {
  /** Anything differs from where the editor started. */
  readonly changed: boolean;
  /** What it may now do that it could not, in words. */
  readonly added: string[];
  /** What it may no longer do, in words. */
  readonly removed: string[];
  /** Its spaces, projects or objects differ. */
  readonly placeChanged: boolean;
  /** It ends up able to do more: a permission added, or reach widened. */
  readonly widens: boolean;
}

const sorted = (ids: readonly string[] | null | undefined): string[] =>
  [...(ids ?? [])].sort();

/** Axis went from narrowed to wider (none, or an id it did not have). */
function axisWidened(
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined
): boolean {
  const b = sorted(before);
  if (b.length === 0) return false;
  const a = sorted(after);
  return a.length === 0 || a.some((id) => !b.includes(id));
}

const AXES = ["workspaceIds", "projectIds", "entityIds"] as const;

/**
 * What saving would change, grant against grant (the editor never reorders
 * them). Permissions are compared as the door would store them (normalised),
 * and worded with the consent page's `permissionLabel`.
 */
export function describeEdit(
  before: readonly ListedGrantDraft[],
  after: readonly ListedGrantDraft[],
  label: (permission: string) => string = permissionLabel
): KeyEditChange {
  const added: string[] = [];
  const removed: string[] = [];
  let placeChanged = false;
  let widens = false;
  const push = (into: string[], p: string) => {
    const w = label(p);
    if (!into.includes(w)) into.push(w);
  };
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const was = before[i]
      ? new Set(draftToGrantInput(before[i]).permissions)
      : new Set<string>();
    const now = after[i]
      ? new Set(draftToGrantInput(after[i]).permissions)
      : new Set<string>();
    for (const p of now) if (!was.has(p)) push(added, p);
    for (const p of was) if (!now.has(p)) push(removed, p);
    for (const axis of AXES) {
      const a = sorted(before[i]?.[axis]).join(",");
      const b = sorted(after[i]?.[axis]).join(",");
      if (a !== b) placeChanged = true;
      if (axisWidened(before[i]?.[axis], after[i]?.[axis])) widens = true;
    }
  }
  return {
    changed: added.length > 0 || removed.length > 0 || placeChanged,
    added,
    removed,
    placeChanged,
    widens: widens || added.length > 0,
  };
}

/** A list capped for a sentence: up to `max`, the rest counted (never just one more). */
export function capList(
  items: readonly string[],
  max = 4
): { readonly shown: string[]; readonly more: number } {
  if (items.length <= max + 1) return { shown: [...items], more: 0 };
  return { shown: items.slice(0, max), more: items.length - max };
}
