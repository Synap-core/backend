/**
 * What agents on one computer may do — the pure half of the computer page's
 * section (plan 07ecf0be item 1, D2a: a person's computer is the ceiling of
 * every agent on it, the stricter of the two always wins). Framework-free, so
 * the decisions worth testing live here and the component only draws.
 *
 * The computer's own mode is read and written like an agent's
 * (`agentUsers.governance` / `agentUsers.setPosture` with the COMPUTER's id:
 * a computer is an agent user of type `machine`), through `agent-writes.ts`.
 *
 * "Show the rules": every rule that applies to this computer or to an agent
 * on it, each tagged with where it comes from — the resolver reads exactly
 * these principals for an agent and for its computer (`principalEligible`:
 * `any` rows, the principal's own `agent` rows, `class` rows of its type).
 */

import {
  MACHINE_AGENT_TYPE,
  agentPostureOfWriteMode,
  effectiveAgentWriteMode,
  isAgentWriteMode,
  type AgentEffectiveWriteMode,
  type AgentWriteMode,
} from "@synap-core/types/agents";
import {
  OWN_ORGANISE_CLASS_PATTERN,
  REVERSIBLE_CLASS_PATTERN,
} from "@synap-core/types/governance-rules";
import { ruleTarget } from "../../settings/review/_lib/request-rules-model";

/** The slice of a `governanceRules.listAll` row this reads. */
export interface RuleRowLike {
  id: string;
  principalKind: string;
  agentUserId: string | null;
  principalClass?: string | null;
  scopeKind: string;
  workspaceId: string | null;
  targetKind: string;
  targetPattern: string;
  targetProfile?: string | null;
  verdict: string;
}

/** Where a rule comes from, as the computer page names it. */
export type RuleSource =
  | { kind: "computer" }
  | { kind: "allComputers" }
  | { kind: "agent"; agentId: string; name: string }
  | { kind: "agentClass"; agentType: string }
  | { kind: "pod" };

/**
 * A rule whose target is a whole class of writes rather than one write: the
 * pod default (`@reversible`), tidying an agent's own new work
 * (`@own-organise`), every write (`*`). The page names these in its own copy.
 */
export type RuleTargetClass = "reversible" | "ownOrganise" | "everything";

const TARGET_CLASSES: Readonly<Record<string, RuleTargetClass>> = {
  [REVERSIBLE_CLASS_PATTERN]: "reversible",
  [OWN_ORGANISE_CLASS_PATTERN]: "ownOrganise",
  "*": "everything",
};

export interface ComputerRule {
  id: string;
  /** What it covers, in the vocabulary's words — never a raw key. */
  what: string;
  /** Set when the target is a class of writes ({@link RuleTargetClass}). */
  targetClass: RuleTargetClass | null;
  verdict: "auto" | "propose" | "deny";
  /** The space it is limited to, or `null` pod-wide. */
  workspaceId: string | null;
}

export interface ComputerRuleGroup {
  /** Stable key for the list. */
  key: string;
  source: RuleSource;
  rules: ComputerRule[];
}

const VERDICTS = new Set(["auto", "propose", "deny"]);

/**
 * Every rule that applies to the computer or to one of its agents, grouped by
 * source in the order a person reads them: the computer's own, the rules for
 * all computers, each agent's own, each agent type's, then the pod's default.
 * A group with no rule is left out; a rule about anyone else is never shown.
 */
export function computerRuleGroups(
  rows: readonly RuleRowLike[],
  ctx: {
    computerId: string;
    agents: ReadonlyArray<{
      id: string;
      name: string;
      agentType: string | null;
    }>;
  }
): ComputerRuleGroup[] {
  const groups = new Map<string, ComputerRuleGroup>();
  const add = (key: string, source: RuleSource, r: RuleRowLike) => {
    if (!VERDICTS.has(r.verdict)) return;
    const g = groups.get(key) ?? { key, source, rules: [] };
    g.rules.push({
      id: r.id,
      what: ruleTarget(r),
      targetClass:
        r.targetKind === "action"
          ? (TARGET_CLASSES[r.targetPattern] ?? null)
          : null,
      verdict: r.verdict as ComputerRule["verdict"],
      workspaceId: r.scopeKind === "workspace" ? r.workspaceId : null,
    });
    groups.set(key, g);
  };
  const agentTypes = new Set(
    ctx.agents.map((a) => a.agentType).filter((t): t is string => !!t)
  );
  for (const r of rows) {
    if (r.principalKind === "any") add("pod", { kind: "pod" }, r);
    else if (r.principalKind === "class" && r.principalClass) {
      if (r.principalClass === MACHINE_AGENT_TYPE)
        add("allComputers", { kind: "allComputers" }, r);
      else if (agentTypes.has(r.principalClass))
        add(
          `class:${r.principalClass}`,
          { kind: "agentClass", agentType: r.principalClass },
          r
        );
    } else if (r.principalKind === "agent" && r.agentUserId) {
      if (r.agentUserId === ctx.computerId)
        add("computer", { kind: "computer" }, r);
      else {
        const agent = ctx.agents.find((a) => a.id === r.agentUserId);
        if (agent)
          add(
            `agent:${agent.id}`,
            { kind: "agent", agentId: agent.id, name: agent.name },
            r
          );
      }
    }
  }
  const rank = (s: RuleSource) =>
    ({ computer: 0, allComputers: 1, agent: 2, agentClass: 3, pod: 4 })[s.kind];
  return [...groups.values()].sort(
    (a, b) => rank(a.source) - rank(b.source) || a.key.localeCompare(b.key)
  );
}

// ─── Its agents: what each one's writes REALLY follow ────────────────────────

/** The slice of an agent's `agentUsers.governance` this reads. */
export interface AgentOnComputerRead {
  /** The agent's OWN mode (what its choice control shows). */
  writeMode: AgentWriteMode;
  postures: { pod: string | null };
  /** The mode its writes follow once its computer is counted (the pod's read). */
  effective?: AgentEffectiveWriteMode | null;
}

/** Where an agent's mode comes from, as its row on the computer page marks it. */
export type AgentModeSource = "agent" | "computer" | "pod-default";

/**
 * An agent row's mode and its mark, from the pod's effective read (the
 * stricter of the agent and this computer, `decidedBy`). A pod with no
 * effective read yet falls back to the agent's own setting.
 */
export function agentModeOnComputer(read: AgentOnComputerRead): {
  mode: AgentWriteMode;
  source: AgentModeSource;
} {
  if (read.effective)
    return { mode: read.effective.writeMode, source: read.effective.decidedBy };
  return {
    mode: read.writeMode,
    source: isAgentWriteMode(read.postures.pod) ? "agent" : "pod-default",
  };
}

/** How many of its agents follow this computer's mode instead of their own. */
export function heldByThisComputer(
  reads: readonly AgentOnComputerRead[]
): number {
  return reads.filter((r) => agentModeOnComputer(r).source === "computer")
    .length;
}

/**
 * How many agents a change of the computer's mode would change — said before
 * it is saved. Each agent's writes follow the stricter of its own mode and
 * the computer's (`effectiveAgentWriteMode`, the same rule as the pod's read
 * and the resolver's host step); an agent changes when that stricter mode
 * moves.
 */
export function agentsChangedBy(
  reads: readonly AgentOnComputerRead[],
  from: AgentWriteMode,
  to: AgentWriteMode
): number {
  if (from === to) return 0;
  const side = (mode: AgentWriteMode) => ({
    mode,
    posture: agentPostureOfWriteMode(mode),
  });
  return reads.filter((r) => {
    const own = { mode: r.writeMode, posture: r.postures.pod };
    return (
      effectiveAgentWriteMode(own, side(from)).mode !==
      effectiveAgentWriteMode(own, side(to)).mode
    );
  }).length;
}
