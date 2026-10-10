/**
 * What a pending agent key would be allowed to do, as both approval pages
 * read it (`/setup/agent/pending/:keyId/details` and `/pending/lookup`):
 * the key's scopes, EVERY live grant scope (`null` = never granted) and its
 * real expiry. Words come from `@synap-core/types` — nothing named here.
 */
import {
  KEY_ACCESS_ENDED_SENTENCE,
  KEY_ACCESS_UNGRANTED_SENTENCE,
  summarizeGrant,
  type GrantDraft,
} from "@synap-core/types/grants";
import { humanizeToken } from "@synap-core/types/vocabulary";

export interface PendingAccess {
  scopes: string[];
  grants: GrantDraft[] | null;
  expiresAt: string | null;
}

export interface PendingAccessView {
  /** Unbounded: never granted, or an un-narrowed `*` grant. Mark as danger. */
  full: boolean;
  /** The danger chip's words, when `full`. */
  fullLabel: string | null;
  /** One sentence per grant scope: what · where (the expiry is `when`). */
  lines: string[];
  /** The key's real expiry: "Until 12 Jan 2027" / "Never expires" / "Expired". */
  when: string;
  expired: boolean;
  /** The key's scopes, in words — for the "Technical details" disclosure. */
  scopeLabels: string[];
}

/** True once a lookup row carries the access facts (an older pod sends none). */
export function hasAccessFacts(k: Partial<PendingAccess>): k is PendingAccess {
  return Array.isArray(k.scopes) && k.grants !== undefined && "expiresAt" in k;
}

export function viewPendingAccess(a: PendingAccess): PendingAccessView {
  const { when, expired } = summarizeGrant(
    { permissions: [] },
    { expiresAt: a.expiresAt }
  );
  const scopeLabels = a.scopes.map(humanizeToken);
  if (a.grants === null)
    return {
      full: true,
      fullLabel: KEY_ACCESS_UNGRANTED_SENTENCE,
      lines: [],
      when,
      expired,
      scopeLabels,
    };
  if (a.grants.every((g) => g.permissions.length === 0))
    return {
      full: false,
      fullLabel: null,
      lines: [KEY_ACCESS_ENDED_SENTENCE],
      when,
      expired,
      scopeLabels,
    };
  const summaries = a.grants.map((g) =>
    summarizeGrant(g, { expiresAt: a.expiresAt })
  );
  // A `*` grant narrowed to a workspace is bounded; its line says where.
  const full = summaries.some((s) => s.full && s.where.length === 0);
  return {
    full,
    fullLabel: full ? "Full access: everything you can do" : null,
    lines: summaries.map((s) => [s.what, ...s.where].join(" · ")),
    when,
    expired,
    scopeLabels,
  };
}

/** The approve button names what it hands over. */
export function approveLabel(fullAccess: boolean, count = 1): string {
  if (count > 1)
    return fullAccess
      ? `Approve all ${count}, full access included`
      : `Approve all ${count}`;
  return fullAccess ? "Approve full access" : "Approve";
}
