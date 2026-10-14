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
 *   3. single    exactly one eligible agent in the pool.
 *   4. choose    zero or several: the PERSON picks (founder decision,
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
 * ── The brand ──
 * `Routed` can only be built here. A function that hands work to an agent
 * takes a `Routed`, so a door that skips `route()` does not compile.
 */

import type { AgentReach } from "@synap-core/types/agents";
import {
  listDispatchableAgentIds,
  ownedAgentIds,
  resolveAgentReachMany,
} from "./agent-binding.js";
import { agentsOperatedBy } from "../agent-presence.js";

/** How a caller names an agent. */
export type AgentSelector = { agentUserId: string };

/** Which rung decided. */
export type RouteVia = "selector" | "roster" | "single";

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
 *   not_member   the pool is a room and the agent is not in it.
 */
export type RouteRefusal = "wrong_reach" | "not_owned" | "not_member";

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
  /**
   * Where rungs 3–4 look:
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

/** The person's own agents of an accepted reach, oldest first. */
async function ownedPool(
  ownerId: string,
  accept: readonly AgentReach[]
): Promise<string[]> {
  // Only dispatch agents are listed pod-wide today: a pull agent or a house
  // agent is never picked for someone's work without being named or rostered.
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
    const reach = await resolveAgentReachMany([id]);
    const r = reach.get(id)!;
    if (!work.accept.includes(r)) {
      return { kind: "refused", reason: "wrong_reach", agentUserId: id, reach: r };
    }
    if (roomMembers && !roomMembers.has(id)) {
      return { kind: "refused", reason: "not_member", agentUserId: id, reach: r };
    }
    const floor = await passFloor(work.ownerId, [id], reach, roomMembers);
    if (!floor.has(id)) {
      return { kind: "refused", reason: "not_owned", agentUserId: id, reach: r };
    }
    return routed(id, r, "selector");
  }

  // 2. roster — the first eligible member.
  const rosterReach = await resolveAgentReachMany(roster);
  const eligible = (ids: readonly string[], reach: ReadonlyMap<string, AgentReach>) =>
    ids.filter((id) => work.accept.includes(reach.get(id)!));
  const rosterFloor = await passFloor(
    work.ownerId,
    eligible(roster, rosterReach),
    rosterReach,
    roomMembers
  );
  const rosterEligible = roster.filter((id) => rosterFloor.has(id));
  if (work.pool === "owned" && rosterEligible.length > 0) {
    const id = rosterEligible[0]!;
    return routed(id, rosterReach.get(id)!, "roster");
  }

  // 3–4. single, else the person chooses.
  let candidates = rosterEligible;
  if (work.pool === "owned") {
    const pool = await ownedPool(work.ownerId, work.accept);
    const poolReach = await resolveAgentReachMany(pool);
    const floor = await passFloor(
      work.ownerId,
      eligible(pool, poolReach),
      poolReach,
      null
    );
    candidates = pool.filter((id) => floor.has(id));
    if (candidates.length === 1) {
      return routed(candidates[0]!, poolReach.get(candidates[0]!)!, "single");
    }
    return { kind: "choose", candidates };
  }
  if (candidates.length === 1) {
    return routed(candidates[0]!, rosterReach.get(candidates[0]!)!, "single");
  }
  return { kind: "choose", candidates };
}
