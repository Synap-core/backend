/**
 * What approving a connection does to the agent's OTHER connections — read
 * from `/setup/agent/pending/:keyId/details` (`connections`, `supersededBy`).
 *
 * One agent (Claude Code) runs on several computers; each computer's key
 * carries its own instance. Approving replaces ONLY the same computer's live
 * key; every other live connection — another computer, or an unlabelled one
 * from an older CLI — keeps working unless the person ticks "Also disconnect"
 * (2026-10-12: approving any request switched every other computer off).
 *
 * Pure: the page renders exactly what this returns. An older pod sends no
 * `connections`; that reads as `known: false`, never as "no other computer".
 */
import { formatRelative } from "../../(admin)/trust-keys/_lib/format";

/** One of the agent's other live connections, as the pod sends it. */
export interface OtherConnection {
  keyId: string;
  instanceId: string | null;
  instanceLabel: string | null;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Same computer as the request: approving replaces it. */
  sameComputer: boolean;
}

/** The connection facts on the details answer (absent from an older pod). */
export interface ConnectionFacts {
  displayName?: string;
  instanceLabel?: string | null;
  createdAt?: string;
  connections?: OtherConnection[];
  supersededBy?: { keyId: string; createdAt: string } | null;
}

/** The words for a connection made by a CLI that sent no computer name. */
export const UNLABELLED_COMPUTER = "unlabelled (older CLI)";

export interface ConnectionRow {
  keyId: string;
  /** The computer's name, or {@link UNLABELLED_COMPUTER}. */
  computer: string;
  /** "last used 5m ago" / "never used". */
  lastUsed: string;
}

export interface ConnectionsView {
  /** The pod sent the facts (an older pod does not). */
  known: boolean;
  /** "Claude Code on devbox" — the connection being approved. */
  title: string | null;
  /** "Requested 3m ago" for the request itself. */
  requested: string | null;
  /** This computer's live connection(s): approving replaces them. */
  replaced: ConnectionRow[];
  /** Every other live connection: kept unless chosen. */
  others: ConnectionRow[];
  /** A newer request from this computer is waiting: this one is not offered. */
  superseded: boolean;
}

function toRow(c: OtherConnection): ConnectionRow {
  return {
    keyId: c.keyId,
    computer: c.instanceLabel?.trim() || UNLABELLED_COMPUTER,
    lastUsed: c.lastUsedAt
      ? `last used ${formatRelative(c.lastUsedAt)}`
      : "never used",
  };
}

export function viewConnections(f: ConnectionFacts): ConnectionsView {
  const list = Array.isArray(f.connections) ? f.connections : null;
  return {
    known: list !== null,
    title: f.displayName?.trim() || null,
    requested: f.createdAt ? `Requested ${formatRelative(f.createdAt)}` : null,
    replaced: (list ?? []).filter((c) => c.sameComputer).map(toRow),
    others: (list ?? []).filter((c) => !c.sameComputer).map(toRow),
    superseded: !!f.supersededBy,
  };
}

/** The approve body: only ids the view offered as a choice survive. */
export function approveBody(
  view: ConnectionsView,
  chosen: readonly string[]
): { alsoDisconnect: string[] } {
  const offered = new Set(view.others.map((r) => r.keyId));
  return { alsoDisconnect: chosen.filter((id) => offered.has(id)) };
}
