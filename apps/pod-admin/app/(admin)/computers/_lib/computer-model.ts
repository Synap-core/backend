/**
 * Computers as the console shows them — pure, so every rule is unit-tested.
 *
 * A computer (MACHINE-IDENTITY-PLAN) is an agent user of type `machine`; the
 * pod's `machines.list` / `machines.adminList` already derive each key's
 * state (`MachineKeyState`, `services/machine-roster.ts`). This file only
 * decides the words and the pill for that state, the list's filters, and the
 * impact a revoke has — the same reading the desktop's Connected › Computers
 * makes (`computers-model.ts` in the browser repo), so the two cannot disagree
 * about what "Expiring" means.
 *
 * Shared by `/computers` (every member's, pod admin) and `/my-computers` (the
 * person's own): the rows are the same shape, `owner` is only on the admin's.
 */

import {
  computerKeyRead,
  computerKeyState,
  days,
  isLiveKey,
  seenLine,
  type ComputerBelongsTo,
  type ComputerKeyLike as SharedComputerKeyLike,
  type ComputerKeyState,
} from "@synap-core/types/computers";
import { resolveComputerBelongsToLabel } from "@synap-core/types/vocabulary";
import type { SubjectEventLike } from "../../../_lib/object/subject-activity";
import type { StatusKind } from "../../components/status-pill";

// The key rule, the "never seen" words, the OS names and the commands are the
// ONE computer rule (`@synap-core/types/computers`), shared with the desktop
// and Relay. This file keeps only what is the console's: pills, filters, impact.
export {
  computerKeyState,
  days,
  daysLeft,
  CONNECT_COMMAND,
  isLiveKey,
  platformLabel,
  RECONNECT_COMMAND,
  type ComputerKeyState,
} from "@synap-core/types/computers";

export interface ComputerKeyLike extends SharedComputerKeyLike {
  id: string;
}

export interface ComputerAgentLike {
  id: string;
  agentType: string | null;
  name: string;
  displayName: string;
  lastSeenAt: Date | string | null;
  key: ComputerKeyLike | null;
}

/** A row of `machines.list` (and of `machines.adminList`, which adds `owner`). */
export interface ComputerLike {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  createdAt: Date | string;
  lastSeenAt: Date | string | null;
  key: ComputerKeyLike | null;
  keyTtlDays: number | null;
  effectiveKeyTtlDays: number;
  minKeyTtlDays: number;
  maxKeyTtlDays: number;
  accessName: string | null;
  /** "Runs scripts" is on: it leases its person's box runs. */
  runsScripts?: boolean;
  /** Whose computer it is (0388): the person's own, an agent's, or shared. */
  belongsTo?: ComputerBelongsTo | null;
  agents: ComputerAgentLike[];
  owner?: { id: string; name: string } | null;
}

// ─── Key state → words ───────────────────────────────────────────────

const KEY_PILL: Record<ComputerKeyState, StatusKind> = {
  active: "healthy",
  expiring: "stale",
  expired: "down",
  revoked: "unknown",
  none: "unknown",
};

/**
 * A key's state as the console's pill. A live key is healthy; one about to
 * lapse is amber and says how long it has (the computer renews it on its own
 * at `synap login`); a lapsed key failed; a revoked one is simply off.
 *
 * `withDetail` is for a pill with room (the computer's own header): an active
 * key then adds the shared rule's detail, "Active · 12 days left".
 */
export function keyStatus(
  key: ComputerKeyLike | null,
  now: number = Date.now(),
  { withDetail = false }: { withDetail?: boolean } = {}
): { kind: StatusKind; label: string } {
  const { state, label, detail } = computerKeyRead(key, now);
  return {
    kind: KEY_PILL[state],
    label: withDetail && detail ? `${label} · ${detail}` : label,
  };
}

// ─── The list ────────────────────────────────────────────────────────

export type ComputerFilter =
  "all" | "active" | "expiring" | "expired" | "revoked";

export const COMPUTER_FILTERS: ReadonlyArray<{
  key: ComputerFilter;
  label: string;
}> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "expiring", label: "Expiring" },
  { key: "expired", label: "Expired" },
  { key: "revoked", label: "Revoked" },
];

/** `?status=` → a filter; anything unknown is the default. */
export function computerFilterOf(
  value: string | null | undefined
): ComputerFilter {
  return COMPUTER_FILTERS.some((f) => f.key === value)
    ? (value as ComputerFilter)
    : "all";
}

/** A computer with no key at all shows under All only. */
export function computerMatches(
  filter: ComputerFilter,
  c: Pick<ComputerLike, "key">
): boolean {
  return filter === "all" || computerKeyState(c) === filter;
}

export function computerCounts(
  computers: readonly Pick<ComputerLike, "key">[]
): Record<ComputerFilter, number> {
  const counts: Record<ComputerFilter, number> = {
    all: computers.length,
    active: 0,
    expiring: 0,
    expired: 0,
    revoked: 0,
  };
  for (const c of computers) {
    const state = computerKeyState(c);
    if (state !== "none") counts[state] += 1;
  }
  return counts;
}

/** "Runs 3 agents" · "Runs 1 agent" · "No agents". */
export function agentsPhrase(n: number): string {
  if (n === 0) return "No agents";
  return `Runs ${n} agent${n === 1 ? "" : "s"}`;
}

/** "6 agents on 3 computers" — the list's one-line roll-up. */
export function rosterLine(computers: readonly ComputerLike[]): string {
  const agents = computers.reduce((n, c) => n + c.agents.length, 0);
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(agents, "agent")} on ${plural(computers.length, "computer")}`;
}

/** How many computers lost their key to expiry. */
export function expiredCount(
  computers: readonly Pick<ComputerLike, "key">[]
): number {
  return computers.filter((c) => computerKeyState(c) === "expired").length;
}

/**
 * The callout over the list: how many computers lost their key to expiry. A
 * computer whose key is only expiring renews it on its own, so it is not
 * called out; one that expired has to be reconnected from the machine.
 */
export function expiredLine(
  computers: readonly Pick<ComputerLike, "key">[]
): string | null {
  const n = expiredCount(computers);
  if (n === 0) return null;
  return n === 1
    ? "One computer's key has expired"
    : `${n} computers' keys have expired`;
}

/** The callout's body over the reconnect command, for `n` expired computers. */
export function expiredReconnectLine(n: number): string {
  return n === 1
    ? "Its agents can't reach the pod until it has a fresh key. Run this on that computer:"
    : "Their agents can't reach the pod until each has a fresh key. Run this on each of those computers:";
}

// ─── One computer ────────────────────────────────────────────────────

/**
 * Whose computer it is, as the reader says it: "you" for their own (the
 * self-service page, or an admin's own computer), else the owner's name.
 */
export function ownerWords(
  c: Pick<ComputerLike, "owner">,
  viewerId: string | null
): string | null {
  if (c.owner === undefined) return "you";
  if (!c.owner) return null;
  return viewerId && c.owner.id === viewerId ? "you" : c.owner.name;
}

/**
 * Whose computer it is, as its mark: "Personal", "An agent's", "Shared" —
 * the vocabulary's words. Null when the pod did not say (a row from before
 * 0388): no mark, never a guess.
 */
export function belongsToMark(
  c: Pick<ComputerLike, "belongsTo">
): string | null {
  return c.belongsTo ? resolveComputerBelongsToLabel(c.belongsTo) : null;
}

/**
 * Whose scripts "Runs scripts" runs, in the reader's words. The computer
 * leases its OWNER's box runs, never the viewer's: an admin on Marie's
 * computer reads "Marie's scripts", Marie reads "your scripts", and an owner
 * the console does not know reads "its owner's".
 */
export function scriptsOwnerWords(
  c: Pick<ComputerLike, "owner">,
  viewerId: string | null
): { whose: string; approves: string } {
  const owner = ownerWords(c, viewerId);
  if (owner === "you") return { whose: "your", approves: "you approve" };
  if (owner) return { whose: `${owner}'s`, approves: `${owner} approves` };
  return { whose: "its owner's", approves: "its owner approves" };
}

/**
 * The header's one sentence: "Runs 3 agents for Antoine. Seen 4m ago." The
 * seen part is the shared rule's (`seenLine`: "Seen …" or "Not seen yet").
 * `relative` is the console's `formatRelative`, injected so this stays pure.
 */
export function computerSummary(
  c: Pick<ComputerLike, "agents" | "lastSeenAt" | "owner">,
  viewerId: string | null,
  relative: (date: Date | string) => string
): string {
  const owner = ownerWords(c, viewerId);
  const n = c.agents.length;
  const runs =
    n === 0
      ? owner
        ? `No agents run on it; it belongs to ${owner}.`
        : "No agents run on it."
      : `${agentsPhrase(n)}${owner ? ` for ${owner}` : ""}.`;
  return `${runs} ${seenLine(c.lastSeenAt, relative)}.`;
}

/** "90 days (pod default)" · "30 days (this computer)". */
export function keyLifetimeLine(
  c: Pick<ComputerLike, "keyTtlDays" | "effectiveKeyTtlDays">
): string {
  return c.keyTtlDays === null
    ? `${days(c.effectiveKeyTtlDays)} (pod default)`
    : `${days(c.keyTtlDays)} (this computer)`;
}

/** A lifetime the pod will take for this computer (whole days, in bounds). */
export function validKeyTtl(
  value: number,
  c: Pick<ComputerLike, "minKeyTtlDays" | "maxKeyTtlDays">
): boolean {
  return (
    Number.isInteger(value) &&
    value >= c.minKeyTtlDays &&
    value <= c.maxKeyTtlDays
  );
}

/** One key the computer carries: its own, or one of its agents'. */
export interface ComputerKeyRow {
  holderId: string;
  holderName: string;
  /** The computer's own key (vs an agent's). */
  own: boolean;
  key: ComputerKeyLike;
}

/** The computer's key first, then each agent's — only principals holding one. */
export function keysOnComputer(c: ComputerLike): ComputerKeyRow[] {
  const rows: ComputerKeyRow[] = [];
  if (c.key)
    rows.push({ holderId: c.id, holderName: c.name, own: true, key: c.key });
  for (const a of c.agents)
    if (a.key)
      rows.push({ holderId: a.id, holderName: a.name, own: false, key: a.key });
  return rows;
}

/**
 * What a revoke cuts: the live keys on the computer (its own and its agents')
 * and the agents it disconnects. `machines.revoke` revokes every live key of
 * the computer and of each agent it hosts (`revokeMachine`); a principal's
 * newest live key is what the roster carries, so `liveKeys` is a floor.
 */
export function revokeImpact(c: ComputerLike): {
  liveKeys: number;
  agents: number;
} {
  return {
    liveKeys: keysOnComputer(c).filter((k) => isLiveKey(k.key)).length,
    agents: c.agents.filter((a) => isLiveKey(a.key)).length,
  };
}

// ─── Activity ────────────────────────────────────────────────────────

/**
 * One activity row in words. The computer's own acts (`machines.*`) carry a
 * `data.kind`; anything else falls back to its event type, humanized.
 * `whose` is `scriptsOwnerWords(…).whose`: the scripts are its owner's.
 */
export function activityLine(
  e: SubjectEventLike,
  humanize: (token: string) => string,
  whose: string
): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  switch (data.kind) {
    case "machine_rename":
      return typeof data.to === "string"
        ? `Renamed to “${data.to}”`
        : "Renamed";
    case "machine_key_ttl":
      return typeof data.keyTtlDays === "number"
        ? `Key lifetime set to ${days(data.keyTtlDays)}`
        : "Key lifetime back to the pod default";
    case "machine_runs_scripts":
      return data.enabled === true
        ? `Set to run ${whose} scripts`
        : `Stopped running ${whose} scripts`;
    case "machine_revoke":
      return typeof data.revokedKeys === "number"
        ? `Revoked — ${data.revokedKeys} key${data.revokedKeys === 1 ? "" : "s"} stopped working`
        : "Revoked";
    default:
      return humanize(e.eventType.split(".").slice(0, 2).join(" "));
  }
}

/** "revokes 4 keys and disconnects 3 agents" — the danger row's line. */
export function revokeLine(c: ComputerLike): string {
  const { liveKeys, agents } = revokeImpact(c);
  if (liveKeys === 0) return "Nothing on it can reach the pod now.";
  const keys = `${liveKeys} key${liveKeys === 1 ? "" : "s"}`;
  return agents > 0
    ? `Revokes ${keys} and disconnects ${agents} agent${agents === 1 ? "" : "s"}.`
    : `Revokes ${keys}.`;
}
