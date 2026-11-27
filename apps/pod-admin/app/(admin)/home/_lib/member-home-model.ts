/**
 * A member's Home, as pure facts (plan W4, architecture report §C): what
 * they can reach (My access), what their AIs made for them (Made for you)
 * and the receipts of what their AIs did (Done for you). The cards in
 * `member-cards.tsx` only draw what this file decides, so every state and
 * every door is tested here.
 *
 * Reads, all on the viewer's own floor (nothing here widens one):
 *   - spaces       `workspaces.list` (memberships + pod-visible spaces)
 *   - computers    `machines.list` (the computers the viewer approved)
 *   - keys         `apiKeys.list` (the viewer's keys and their agents')
 *   - made for you `artifacts.list` (the session output ledger, floored to
 *                  the viewer's spaces + own pod-personal rows), narrowed
 *                  HERE to the rows an agent produced whose owner is the
 *                  viewer. No pod door lists "made for me" yet: this is the
 *                  narrowest honest read, and it never widens the floor
 *   - receipts     `proposals.list { agentOnly, excludeBookkeeping }`, the
 *                  same rows History draws (`historyRows`)
 *
 * No session, goal or "needs you" status is read or drawn: work status stays
 * in the desktop and phone apps (founder, 16 Nov 2026).
 */

import { humanizeToken, resolveObjectNoun } from "@synap-core/types/vocabulary";
import { navHref } from "../../../../lib/console-nav";
import { objectPage } from "../../../_lib/object/content/markdown-model";
import {
  historyRows,
  type HistoryProposal,
  type HistoryRow,
} from "../../history/_lib/history-rows";

// ─── One card's state ──────────────────────────────────────────────────

/**
 * What a card knows. Five facts, each drawn apart: a read in flight, a read
 * that cannot start because the browser is offline, a read that FAILED
 * (never folded into empty), a read that answered nothing, and an answer.
 */
export type CardState<T> =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "failed" }
  | { kind: "empty" }
  | { kind: "ready"; value: T };

/** The fields of a TanStack query this file reads. */
export interface QueryFacts<D> {
  isError: boolean;
  data: D | undefined;
  /** `paused` = the query waits for the network (TanStack's offline mode). */
  fetchStatus?: "fetching" | "paused" | "idle";
}

/**
 * A query → its card state. `project` turns the answer into what the card
 * draws, `null` when there is nothing to draw. A failed refetch over an older
 * answer is still a failed read; an answer held from before going offline is
 * still drawn.
 */
export function cardState<D, T>(
  query: QueryFacts<D>,
  project: (data: D) => T | null
): CardState<T> {
  if (query.isError) return { kind: "failed" };
  if (query.data === undefined) {
    return query.fetchStatus === "paused"
      ? { kind: "offline" }
      : { kind: "loading" };
  }
  const value = project(query.data);
  return value === null ? { kind: "empty" } : { kind: "ready", value };
}

/** A skeleton shows only once a read has taken this long (no flash). */
export const SKELETON_DELAY_MS = 300;

// ─── My access ─────────────────────────────────────────────────────────

/** The `workspaces.list` fields the access card reads. */
export interface SpaceFacts {
  id: string;
  name: string;
  role?: string | null;
}

export interface SpaceRow {
  id: string;
  name: string;
  /** The viewer's role there, in words ("Editor"); null when unknown. */
  role: string | null;
  href: string;
}

/** Spaces shown before "Show all". */
export const SPACES_CAP = 3;

export function spaceRows(spaces: readonly SpaceFacts[]): SpaceRow[] | null {
  const rows = spaces.flatMap((s): SpaceRow[] => {
    const href = objectPage("workspace", s.id);
    return href
      ? [
          {
            id: s.id,
            name: s.name,
            role: s.role ? humanizeToken(s.role) : null,
            href,
          },
        ]
      : [];
  });
  return rows.length > 0 ? rows : null;
}

/** The `machines.list` fields the access card reads. */
export interface ComputerFacts {
  id: string;
}

/** The `apiKeys.list` fields the access card reads. */
export interface KeyFacts {
  id: string;
  isActive: boolean;
  revokedAt?: Date | string | null;
}

/** A count and the page that lists them, for the viewer's own things. */
export interface CountRow {
  count: number;
  href: string;
}

export const MY_DEVICES_HREF = "/my-devices";
export const MY_CONNECTIONS_HREF = "/my-connections";

/**
 * The viewer's computers. Zero is an answer the card still draws (the page
 * it opens is where a computer is connected): never `null`.
 */
export function computerRow(computers: readonly ComputerFacts[]): CountRow {
  return { count: computers.length, href: MY_DEVICES_HREF };
}

/** The viewer's live keys (a revoked or switched-off key gives no access). */
export function keyRow(keys: readonly KeyFacts[]): CountRow {
  return {
    count: keys.filter((k) => k.isActive && !k.revokedAt).length,
    href: MY_CONNECTIONS_HREF,
  };
}

// ─── Made for you ──────────────────────────────────────────────────────

/** The `artifacts.list` fields the card reads. */
export interface ArtifactFacts {
  id: string;
  kind: string;
  refId: string | null;
  title: string;
  workspaceId: string | null;
  userId: string;
  originKind: string;
  state: string;
  entityProfile?: {
    slug: string;
    displayName: string | null;
    icon?: string | null;
  };
}

export interface ArtifactRow {
  id: string;
  title: string;
  /** What it is, as a noun ("Decision", "Document"). */
  noun: string;
  /** The object kind (`entity`, `document`, …). */
  kind: string;
  /** Its own page. */
  href: string;
  workspaceId: string | null;
  /** An entity's card subject (its kind's slug); null for any other object. */
  card: { entityId: string; profileSlug: string; icon: string | null } | null;
}

/** Rows shown before "Show all". */
export const ARTIFACTS_CAP = 5;
/** One read of the ledger; narrowed to the viewer's below. */
export const ARTIFACTS_READ_LIMIT = 50;

/**
 * The ledger rows an AI made for the viewer, newest first as read: produced
 * by an agent (`originKind`), owned by the viewer (the owner is the person an
 * agent acted for), not swept away, and with a page the viewer can open. One
 * row per object: the same record recorded by two sessions is one thing.
 * An entity the viewer cannot read comes back without its kind
 * (`entityProfile`): it is left out rather than offered as a dead door.
 */
export function artifactRows(
  items: readonly ArtifactFacts[],
  viewerId: string
): ArtifactRow[] | null {
  const seen = new Set<string>();
  const rows: ArtifactRow[] = [];
  for (const a of items) {
    if (a.originKind !== "agent" || a.userId !== viewerId) continue;
    if (a.state === "swept" || !a.refId) continue;
    if (a.kind === "entity" && !a.entityProfile) continue;
    const key = `${a.kind}:${a.refId}`;
    if (seen.has(key)) continue;
    const href = objectPage(a.kind, a.refId);
    if (!href) continue;
    seen.add(key);
    const profile = a.kind === "entity" ? a.entityProfile : undefined;
    rows.push({
      id: a.id,
      title: a.title,
      noun: profile
        ? (profile.displayName ?? resolveObjectNoun(profile.slug))
        : resolveObjectNoun(a.kind),
      kind: a.kind,
      href,
      workspaceId: a.workspaceId,
      card: profile
        ? {
            entityId: a.refId,
            profileSlug: profile.slug,
            icon: profile.icon ?? null,
          }
        : null,
    });
  }
  return rows.length > 0 ? rows : null;
}

// ─── Done for you (receipts) ───────────────────────────────────────────

/** Receipts shown on Home; the rest are on History. */
export const RECEIPTS_CAP = 5;

/** `proposals.list`'s input for the card: History's read, narrowed to AI. */
export const RECEIPTS_INPUT = {
  status: "all",
  limit: 10,
  agentOnly: true,
  excludeBookkeeping: true,
} as const;

/** Where "See all" goes: History, the one home of receipts. */
export const RECEIPTS_ALL_HREF = navHref("history");

/** The latest decided requests of the viewer's AIs, History's own rows. */
export function receiptRows(
  items: readonly HistoryProposal[]
): HistoryRow[] | null {
  const rows = historyRows(items).slice(0, RECEIPTS_CAP);
  return rows.length > 0 ? rows : null;
}
