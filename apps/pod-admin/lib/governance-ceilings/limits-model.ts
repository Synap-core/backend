/**
 * Daily write limits (`governance_ceilings`, axis `daily_write_count`): the
 * pure rules behind Approvals › Daily write limits. A limit caps how many
 * writes an agent may run on its own per UTC day. It is opt-in: with no row
 * there is no limit (founder, 2026-10-27).
 *
 * Who it caps (one agent, every agent, every computer), where (the whole pod
 * or one space), the number, today's use against it for one agent's limit, and
 * whether it ends tonight (an "approve and allow today" raise). No React, no
 * words: the page's catalog says each of these.
 */

/** `governance_ceilings.limit_value` is a Postgres `integer`. */
export const LIMIT_VALUE_MAX = 2_147_483_647;

/** Today's use turns to the warning tone from this share of the limit. */
export const LIMIT_WARN_AT = 0.8;

/** The `governanceCeilings.list` fields a row reads, structurally. */
export interface LimitRowLike {
  id: string;
  principalKind: string;
  principalClass?: string | null;
  agentUserId?: string | null;
  agentLabel?: string | null;
  scopeKind: string;
  workspaceId?: string | null;
  limitValue: number;
  expiresAt?: Date | string | null;
}

/** Who a limit caps. */
export type LimitWho =
  | { kind: "agent"; agentUserId: string | null; name: string | null }
  | { kind: "any" }
  | { kind: "computers" };

/**
 * Who a limit caps: the roster's name for one agent, else the name the pod
 * resolved; `null` when neither is known (never an id).
 */
export function limitWho(
  row: LimitRowLike,
  names: ReadonlyMap<string, string>
): LimitWho {
  if (row.principalKind === "class") return { kind: "computers" };
  if (row.principalKind !== "agent") return { kind: "any" };
  const id = row.agentUserId ?? null;
  const fromRoster = id ? names.get(id)?.trim() : undefined;
  const label = row.agentLabel?.trim();
  // The pod falls back to the raw id when the agent has no name: not a name.
  const fromPod = label && label !== id ? label : undefined;
  return {
    kind: "agent",
    agentUserId: id,
    name: fromRoster || fromPod || null,
  };
}

/** Where a limit applies: `null` = the whole pod, else the space's id. */
export function limitSpaceId(row: LimitRowLike): string | null {
  return row.scopeKind === "workspace" ? (row.workspaceId ?? null) : null;
}

/** Epoch ms of a Date-or-string instant, `null` when absent or unreadable. */
function toMs(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * A limit that ends on its own: "approve and allow today" writes one that
 * ends at the next 00:00 UTC. `null` = it holds until taken back.
 */
export function limitEndsAt(row: LimitRowLike): number | null {
  return toMs(row.expiresAt);
}

export interface LimitUsage {
  used: number;
  limit: number;
  /** 0–100, clamped. */
  pct: number;
  /** At or past `LIMIT_WARN_AT` of the limit. */
  warn: boolean;
  /** At or past the limit: further writes ask first today. */
  reached: boolean;
}

/**
 * Today's use against a limit. `null` when there is no count to show: a limit
 * on every agent or every computer has no single agent to count.
 */
export function limitUsage(
  used: number | null | undefined,
  limit: number
): LimitUsage | null {
  if (typeof used !== "number" || !(limit > 0)) return null;
  const pct = Math.max(0, Math.min(100, (used / limit) * 100));
  return {
    used,
    limit,
    pct,
    warn: used >= limit * LIMIT_WARN_AT,
    reached: used >= limit,
  };
}

/** The number typed in "Writes per day": a whole number from 1 up, else `null`. */
export function parseLimitValue(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= LIMIT_VALUE_MAX ? n : null;
}

/** The Add limit form's state. */
export interface LimitDraft {
  who: "any" | "agent";
  agentUserId: string | null;
  where: "pod" | "space";
  workspaceId: string | null;
  value: string;
}

export const EMPTY_LIMIT_DRAFT: LimitDraft = {
  who: "any",
  agentUserId: null,
  where: "pod",
  workspaceId: null,
  value: "",
};

/** `governanceCeilings.create`'s input, structurally. */
export interface CreateLimitInput {
  principalKind: "agent" | "any";
  agentUserId?: string;
  scopeKind: "pod" | "workspace";
  workspaceId?: string;
  limitValue: number;
}

/**
 * The door's input for a draft, or `null` while it is incomplete (no agent
 * picked, no space picked, no valid number): the form's submit stays off.
 */
export function createLimitInput(draft: LimitDraft): CreateLimitInput | null {
  const limitValue = parseLimitValue(draft.value);
  if (limitValue === null) return null;
  if (draft.who === "agent" && !draft.agentUserId) return null;
  if (draft.where === "space" && !draft.workspaceId) return null;
  return {
    principalKind: draft.who,
    ...(draft.who === "agent" ? { agentUserId: draft.agentUserId! } : {}),
    scopeKind: draft.where === "space" ? "workspace" : "pod",
    ...(draft.where === "space" ? { workspaceId: draft.workspaceId! } : {}),
    limitValue,
  };
}
