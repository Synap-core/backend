/**
 * THE ROUTE — the one rule for "which agent takes this work".
 *
 * Every door that hands work to an agent asks here: a playbook run handed to
 * an external agent, a capture given to an agent, a message in a room with
 * several AI members. Before this existed each door had its own picker (the
 * run's `chooseRunAgent`, give-to-agent's reach/ownership branches, the chat
 * room's IS router), and they disagreed: the chat router could hand a turn to
 * an agent the run rule would have refused.
 *
 * ── The rungs, first match wins ──
 *   1. selector  the caller NAMED an agent (a run param, an @mention, a
 *                "Give to agent" pick). Never falls through: a named agent
 *                that cannot take the work is REFUSED, said, never swapped
 *                for another one.
 *   2. roster    an agent already on the work (session roster, room members)
 *                that has an accepted reach and passes the floor.
 *   3. assigned  the agent a person ASSIGNED to what the work is about
 *                (`participant --assigned_to--> …`, 0329), most specific target
 *                first: playbook > profile > project > workspace (founder
 *                decision 2026-10-14). Not read for a room.
 *   4. single    exactly one eligible agent in the pool.
 *   5. choose    zero or several: the PERSON picks (founder decision,
 *                2026-10-13: when several agents fit, ask the person — never
 *                an AI picker).
 *
 * ── The floor ──
 * Every candidate is floored on the person whose work it is, by the rule that
 * makes the agent actually reach them:
 *   dispatch  the person OWNS it (`ownedAgentIds`, the lineage door) — a run
 *             never hands a teammate's agent the work;
 *   pull      it acts FOR the person (`agentsOperatedBy`) — otherwise it would
 *             never see the session;
 *   pod       the person owns it (lineage), or — in a room — it is a member
 *             (the room is the grant).
 *
 * ── Paused ──
 * A PAUSED agent (`users.agent_paused_at`) is skipped by every rung that picks
 * for the person, and refused when named. Pausing never revokes its keys.
 *
 * ── The brand ──
 * `Routed` can only be built here. A function that hands work to an agent
 * takes a `Routed`, so a door that skips `route()` does not compile.
 */

import type { AgentReach } from "@synap-core/types/agents";
import { db, and, eq, inArray, isNotNull, links, users } from "@synap/database";
import {
  listDispatchableAgentIds,
  ownedAgentIds,
  resolveAgentReachMany,
} from "./agent-binding.js";
import { agentsOperatedBy } from "../agent-presence.js";

/**
 * The reaches that can TAKE a person's work handed to an agent (a capture, a
 * session staffed by an AI): a `pull` agent picks it up when it checks in, a
 * `dispatch` agent is pushed it. A `pod` agent answers in a room when asked;
 * it never picks work up.
 */
export const HAND_OFF_ACCEPT: readonly AgentReach[] = ["dispatch", "pull"];

/** How a caller names an agent. */
export type AgentSelector = { agentUserId: string };

/** Which rung decided. */
export type RouteVia = "selector" | "roster" | "assigned" | "single";

/** What an agent can be assigned to, most specific first (the precedence). */
export const ASSIGNMENT_TARGETS = [
  "playbook",
  "profile",
  "project",
  "workspace",
] as const;
export type AssignmentTarget = (typeof ASSIGNMENT_TARGETS)[number];

declare const ROUTED: unique symbol;

/** An agent that may take the work. Only `route()` builds one. */
export interface Routed {
  readonly kind: "routed";
  readonly agentUserId: string;
  readonly reach: AgentReach;
  readonly via: RouteVia;
  readonly [ROUTED]: true;
}

/**
 * Why a NAMED agent cannot take the work:
 *   wrong_reach  the pod cannot hand it this work that way (an external agent
 *                named for an IS turn, a pull agent named for a dispatch run);
 *   not_owned    not the person's agent (dispatch / pod) or does not act for
 *                them (pull);
 *   not_member   the pool is a room and the agent is not in it;
 *   paused       a person paused it.
 */
export type RouteRefusal =
  "wrong_reach" | "not_owned" | "not_member" | "paused";

/** A refusal as the sentence a person (or the AI relaying it) reads. */
export function routeRefusalLine(reason: RouteRefusal, who: string): string {
  switch (reason) {
    case "paused":
      return `${who} is paused: it takes no new work until a person resumes it.`;
    case "not_owned":
      return `${who} does not act for the person whose work this is, so it would never pick it up.`;
    case "wrong_reach":
      return `${who} is run by the pod: it answers in rooms when asked, it never picks work up.`;
    case "not_member":
      return `${who} is not in this room.`;
  }
}

export type RouteResult =
  | Routed
  | {
      readonly kind: "refused";
      readonly reason: RouteRefusal;
      readonly agentUserId: string;
      readonly reach: AgentReach;
    }
  | { readonly kind: "choose"; readonly candidates: string[] };

export interface RouteWork {
  /** The person whose work it is. Every candidate is floored on them. */
  ownerId: string;
  /**
   * The reaches that can take this work: an IS turn `['pod']`; a dispatch run
   * `['dispatch']`; a capture hand-off `['dispatch', 'pull']`.
   */
  accept: readonly AgentReach[];
  /** The agent the caller named, if any. */
  selector?: AgentSelector | null;
  /** The agents already on the work, in order (session roster, room AI members). */
  roster?: readonly string[];
  /** What the work is about — the assignment rung reads these. */
  targets?: Partial<Record<AssignmentTarget, string | null>>;
  /**
   * Where the later rungs look:
   *   owned   the person's own agents of an accepted reach (a run, a hand-off);
   *   roster  the roster only (a room — nobody outside it answers).
   */
  pool: "owned" | "roster";
}

function routed(agentUserId: string, reach: AgentReach, via: RouteVia): Routed {
  return { kind: "routed", agentUserId, reach, via } as Routed;
}

/** The ids among `ids` that pass the floor for their reach. */
async function passFloor(
  ownerId: string,
  ids: readonly string[],
  reach: ReadonlyMap<string, AgentReach>,
  roomMembers: ReadonlySet<string> | null
): Promise<Set<string>> {
  const byLineage = ids.filter((id) => reach.get(id) !== "pull");
  const pulling = ids.filter((id) => reach.get(id) === "pull");
  const [owned, operated] = await Promise.all([
    ownedAgentIds(ownerId, byLineage),
    agentsOperatedBy(ownerId, pulling),
  ]);
  const out = new Set<string>();
  for (const id of ids) {
    const r = reach.get(id);
    if (r === "pull" ? operated.has(id) : owned.has(id)) out.add(id);
    // A room is the grant for an IS turn: a pod agent a teammate added to the
    // room answers there (the turn still runs as the summoner — `turn-principal.ts`).
    else if (r === "pod" && roomMembers?.has(id)) out.add(id);
  }
  return out;
}

/** Which of `ids` a person paused. */
async function pausedAmong(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(inArray(users.id, [...new Set(ids)]), isNotNull(users.agentPausedAt))
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * The agents that may take the work among `ids`, in order: an accepted reach,
 * past the floor, not paused.
 */
async function admit(
  work: RouteWork,
  ids: readonly string[],
  roomMembers: ReadonlySet<string> | null
): Promise<{ ok: string[]; reach: Map<string, AgentReach> }> {
  const reach = await resolveAgentReachMany(ids);
  const accepted = ids.filter((id) => work.accept.includes(reach.get(id)!));
  const [floor, paused] = await Promise.all([
    passFloor(work.ownerId, accepted, reach, roomMembers),
    pausedAmong(accepted),
  ]);
  return {
    ok: accepted.filter((id) => floor.has(id) && !paused.has(id)),
    reach,
  };
}

/**
 * The selector rung, batched: for each id, what `route()` answers when the
 * caller NAMES it — `refusal: null` (it may take the work) or the reason it is
 * refused, checked in the rung's order (reach, room, floor, paused). `route()`'s
 * selector rung IS this function for one id, so a roster that shows "can take
 * your work" (`readAgentsForHandoff`) can never disagree with the hand-off.
 */
export async function namedVerdicts(
  work: Pick<RouteWork, "ownerId" | "accept">,
  ids: readonly string[],
  roomMembers: ReadonlySet<string> | null = null
): Promise<Map<string, { reach: AgentReach; refusal: RouteRefusal | null }>> {
  const uniq = [...new Set(ids)];
  const reach = await resolveAgentReachMany(uniq);
  const accepted = uniq.filter((id) => work.accept.includes(reach.get(id)!));
  const inPool = roomMembers
    ? accepted.filter((id) => roomMembers.has(id))
    : accepted;
  const [floor, paused] = await Promise.all([
    passFloor(work.ownerId, inPool, reach, roomMembers),
    pausedAmong(inPool),
  ]);
  const out = new Map<
    string,
    { reach: AgentReach; refusal: RouteRefusal | null }
  >();
  for (const id of uniq) {
    const r = reach.get(id)!;
    const refusal: RouteRefusal | null = !work.accept.includes(r)
      ? "wrong_reach"
      : roomMembers && !roomMembers.has(id)
        ? "not_member"
        : !floor.has(id)
          ? "not_owned"
          : paused.has(id)
            ? "paused"
            : null;
    out.set(id, { reach: r, refusal });
  }
  return out;
}

/** The assigned agents for the work's targets, most specific target first. */
async function assignedFor(targets: RouteWork["targets"]): Promise<string[]> {
  const pairs = ASSIGNMENT_TARGETS.flatMap((t) =>
    targets?.[t] ? [{ type: t, id: targets[t]! }] : []
  );
  if (pairs.length === 0) return [];
  const rows = await db
    .select({ fromId: links.fromId, toType: links.toType, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.linkType, "assigned_to"),
        eq(links.fromType, "participant"),
        inArray(
          links.toId,
          pairs.map((p) => p.id)
        )
      )
    );
  const out: string[] = [];
  for (const p of pairs) {
    for (const r of rows) {
      if (r.toType === p.type && r.toId === p.id && !out.includes(r.fromId)) {
        out.push(r.fromId);
      }
    }
  }
  return out;
}

/** The person's own agents of an accepted reach, oldest first. */
async function ownedPool(
  ownerId: string,
  accept: readonly AgentReach[]
): Promise<string[]> {
  // Only dispatch agents are listed pod-wide today: a pull agent or a house
  // agent is never picked for someone's work without being named, rostered or
  // assigned.
  return accept.includes("dispatch")
    ? await listDispatchableAgentIds(ownerId)
    : [];
}

export async function route(work: RouteWork): Promise<RouteResult> {
  const roster = [...new Set(work.roster ?? [])];
  const roomMembers = work.pool === "roster" ? new Set(roster) : null;

  // 1. selector — never falls through.
  if (work.selector) {
    const id = work.selector.agentUserId;
    const v = (await namedVerdicts(work, [id], roomMembers)).get(id)!;
    return v.refusal
      ? { kind: "refused", reason: v.refusal, agentUserId: id, reach: v.reach }
      : routed(id, v.reach, "selector");
  }

  // 2. roster — the first eligible member (a room never takes the first: it
  // falls to single / choose below).
  const onRoster = await admit(work, roster, roomMembers);
  if (work.pool === "roster") {
    const [only] = onRoster.ok;
    return onRoster.ok.length === 1 && only
      ? routed(only, onRoster.reach.get(only)!, "single")
      : { kind: "choose", candidates: onRoster.ok };
  }
  if (onRoster.ok[0]) {
    return routed(
      onRoster.ok[0],
      onRoster.reach.get(onRoster.ok[0])!,
      "roster"
    );
  }

  // 3. assigned — the most specific target's agent that may take it.
  const assigned = await admit(work, await assignedFor(work.targets), null);
  if (assigned.ok[0]) {
    return routed(
      assigned.ok[0],
      assigned.reach.get(assigned.ok[0])!,
      "assigned"
    );
  }

  // 4–5. single, else the person chooses.
  const pool = await admit(
    work,
    await ownedPool(work.ownerId, work.accept),
    null
  );
  const [only] = pool.ok;
  if (pool.ok.length === 1 && only) {
    return routed(only, pool.reach.get(only)!, "single");
  }
  return { kind: "choose", candidates: pool.ok };
}
