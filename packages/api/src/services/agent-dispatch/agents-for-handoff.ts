/**
 * "Who can take my work, and on which computer?" — the roster an AI reads
 * before handing work to an agent ("start this session on my devbox").
 *
 * Nothing here is a second derivation. Every fact is read from the door that
 * already owns it:
 *   - WHO is visible   `queryAgentUsers` (the `agentUsers.list` floor; app
 *                      agents are already excluded there);
 *   - last seen        `loadAgentPresence` (the newest key use, and the
 *                      computer label on that same key);
 *   - reach + binding  `loadAgentDispatchSummaries` (THE reach rule, a broken
 *                      binding as `error`, never as "not bound");
 *   - may it take it   `namedVerdicts` — `route()`'s selector rung, batched,
 *                      with `HAND_OFF_ACCEPT`. So `canTakeYourWork` is exactly
 *                      what a hand-off naming this agent would be told.
 *
 * `handOff` previews what a hand-off FROM THE CALLING AGENT would do right now:
 * the route's answer first (`blocked` when it cannot take the work), then the
 * ONE governance resolver's dry run for the gate's own write
 * (`focus_session.assign_agent`, door "chat" — what `gateAgentHandOff` asks
 * `checkPermissionOrPropose`): auto → `direct`, propose → `asks_you`, deny →
 * `blocked`. Two things the preview cannot see, by construction: the session's
 * space (it previews pod-wide, `workspaceId: null` — a space-scoped rule may
 * answer differently), and the per-agent PROPOSAL LIMIT, which
 * `createProposal` checks only when a proposal is filed — so an `asks_you` can
 * still come back refused at the limit; the reply's reason says so.
 *
 * Computers are not rows: an agent of type `machine` is the computer itself.
 * They are listed once under `computers`, with how many listed agents run on
 * each. An agent's computer is its `host_user_id` (the machine it was created
 * on); an agent from before machine identity falls back to the label of the
 * key it was last seen on ("MacBook-Pro"), which has no principal behind it.
 *
 * A failed read throws — "nobody can take it" and "could not tell" are
 * different answers.
 */

import { db, inArray, users } from "@synap/database";
import { dryRunAgentGovernanceDecision } from "@synap/database/agent-governance";
import { MACHINE_AGENT_TYPE, type AgentReach } from "@synap-core/types/agents";
import { queryAgentUsers } from "../../routers/agent-users.js";
import { loadAgentPresence } from "../agent-presence.js";
import { machineName } from "../machine-roster.js";
import { loadAgentDispatchSummaries } from "./agent-binding.js";
import {
  HAND_OFF_ACCEPT,
  namedVerdicts,
  routeRefusalLine,
  type RouteRefusal,
} from "./route.js";

/**
 * A pulling agent counts as LIVE when it called the pod within this window.
 * `synap worker` polls every 30s and key use is stamped at most once a minute
 * (`apiKeyService.recordKeyUse`); its back-off on failed reads caps at 10
 * minutes. 15 minutes covers a worker that is polling, slowly or not.
 */
export const PULL_LIVE_WINDOW_MS = 15 * 60_000;

export interface HandoffComputer {
  /** The computer's own principal; `null` when it is only a key label. */
  agentUserId: string | null;
  name: string;
}

/** What a hand-off from the calling agent would do right now. */
export type HandOffPreview = "direct" | "asks_you" | "blocked";

export interface HandoffAgent {
  agentUserId: string;
  name: string | null;
  agentType: string | null;
  computer: HandoffComputer | null;
  reach: AgentReach;
  /** What `route()` admits when a hand-off NAMES this agent for you. */
  canTakeYourWork: boolean;
  /** Why not, in `route()`'s words; `null` when it can. */
  whyNot: RouteRefusal | null;
  /**
   * pull: it called the pod within `PULL_LIVE_WINDOW_MS`; dispatch: its
   * binding resolves without an error; pod: the pod runs it itself.
   */
  live: boolean;
  paused: boolean;
  lastSeenAt: string | null;
  /** direct = lands on the roster now; asks_you = the person approves first. */
  handOff: HandOffPreview;
  /** Why it asks or is blocked (the resolver's or the route's words). */
  handOffReason: string | null;
}

export interface HandoffRoster {
  agents: HandoffAgent[];
  computers: Array<HandoffComputer & { agents: number }>;
}

export async function readAgentsForHandoff(
  userId: string,
  opts: {
    /** The agent that would do the handing (the MCP key's agent). */
    callerAgentUserId?: string | null;
    now?: Date;
  } = {}
): Promise<HandoffRoster> {
  const now = opts.now ?? new Date();
  const caller = opts.callerAgentUserId ?? null;
  const visible = await queryAgentUsers({ userId }, undefined);
  const ids = visible.map((r) => r.id);
  const identity = ids.length
    ? await db
        .select({
          id: users.id,
          agentType: users.agentType,
          hostUserId: users.hostUserId,
        })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const kindOf = new Map(identity.map((r) => [r.id, r]));
  const isMachine = (id: string) =>
    kindOf.get(id)?.agentType === MACHINE_AGENT_TYPE;

  const agentRows = visible.filter((r) => !isMachine(r.id));
  const agentIds = agentRows.map((r) => r.id);

  // The machines to name: every visible one, plus any machine an agent points
  // at that the roster did not list (its name is already public on the
  // agent: "Claude Code on devbox").
  const hostIds = [
    ...new Set(
      agentIds
        .map((id) => kindOf.get(id)?.hostUserId)
        .filter((h): h is string => !!h)
    ),
  ];
  const machineIds = [
    ...new Set([
      ...visible.filter((r) => isMachine(r.id)).map((r) => r.id),
      ...hostIds,
    ]),
  ];
  const machineRows = machineIds.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          agentMetadata: users.agentMetadata,
          createdByUserId: users.createdByUserId,
        })
        .from(users)
        .where(inArray(users.id, machineIds))
    : [];
  const machineNameOf = new Map(
    machineRows.map((m) => [m.id, machineName(m)] as const)
  );

  const [presence, dispatch, verdicts, gate] = await Promise.all([
    loadAgentPresence(agentIds, now),
    loadAgentDispatchSummaries(agentIds),
    namedVerdicts({ ownerId: userId, accept: HAND_OFF_ACCEPT }, agentIds),
    // A person staffing their own session is never gated (agent-hand-off.ts).
    caller
      ? dryRunAgentGovernanceDecision({
          db,
          userId,
          agentUserId: caller,
          workspaceId: null,
          subjectType: "focus_session",
          action: "assign_agent",
          door: "chat",
        })
      : null,
  ]);

  const agents: HandoffAgent[] = agentRows.map((r) => {
    const seen = presence.get(r.id);
    const hostId = kindOf.get(r.id)?.hostUserId ?? null;
    const computer: HandoffComputer | null =
      hostId && machineNameOf.has(hostId)
        ? { agentUserId: hostId, name: machineNameOf.get(hostId)! }
        : seen?.hostLabel
          ? { agentUserId: null, name: seen.hostLabel }
          : null;
    const summary = dispatch.get(r.id);
    const reach = summary?.reach ?? "pull";
    const lastSeenAt = seen?.lastSeenAt ?? null;
    const live =
      reach === "dispatch"
        ? !!summary?.binding && !summary.binding.error
        : reach === "pull"
          ? !!lastSeenAt &&
            now.getTime() - Date.parse(lastSeenAt) <= PULL_LIVE_WINDOW_MS
          : true;
    const whyNot = verdicts.get(r.id)?.refusal ?? null;
    // An agent adding ITSELF is joining, not a hand-off: never gated.
    const preview: { handOff: HandOffPreview; handOffReason: string | null } =
      whyNot
        ? { handOff: "blocked", handOffReason: routeRefusalLine(whyNot, "It") }
        : !gate || r.id === caller || gate.outcome === "auto"
          ? { handOff: "direct", handOffReason: null }
          : {
              handOff: gate.outcome === "propose" ? "asks_you" : "blocked",
              handOffReason: gate.reason,
            };
    return {
      agentUserId: r.id,
      name: r.name,
      agentType: kindOf.get(r.id)?.agentType ?? null,
      computer,
      reach,
      canTakeYourWork: whyNot === null,
      whyNot,
      live,
      paused: r.pausedAt != null,
      lastSeenAt,
      ...preview,
    };
  });

  // Ready first (can take it AND live), then can take it, then the rest;
  // most recently seen first inside each.
  const rank = (a: HandoffAgent) => (a.canTakeYourWork ? (a.live ? 0 : 1) : 2);
  agents.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")
  );

  // YOUR computers — the machines you approved (`listMachines`' floor) and
  // the labels your agents' keys carry — so "my devbox" never matches a
  // teammate's. A label that carries one of your machines' names IS that
  // machine to the person reading it ("devbox" twice would be two answers to
  // "my devbox"), so it folds into the machine. Two machines with one name
  // stay two: the person picks.
  const computers = new Map<string, HandoffComputer & { agents: number }>();
  const byName = new Map<string, string>();
  const nameKey = (name: string) => name.trim().toLowerCase();
  for (const m of machineRows) {
    if (m.createdByUserId !== userId) continue;
    const name = machineNameOf.get(m.id)!;
    computers.set(`id:${m.id}`, { agentUserId: m.id, name, agents: 0 });
    if (!byName.has(nameKey(name))) byName.set(nameKey(name), `id:${m.id}`);
  }
  for (const a of agents) {
    if (!a.computer) continue;
    // A label from an agent that is not yours names someone else's computer.
    if (!a.computer.agentUserId && a.whyNot === "not_owned") continue;
    const k = a.computer.agentUserId
      ? `id:${a.computer.agentUserId}`
      : (byName.get(nameKey(a.computer.name)) ??
        `label:${nameKey(a.computer.name)}`);
    // An agent on a machine that is not yours: not one of your computers.
    if (a.computer.agentUserId && !computers.has(k)) continue;
    const c = computers.get(k) ?? { ...a.computer, agents: 0 };
    c.agents += 1;
    computers.set(k, c);
  }

  return { agents, computers: [...computers.values()] };
}
