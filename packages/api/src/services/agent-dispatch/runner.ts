/**
 * RESOLVE A RUNNER — who, among the person's agents (or Synap AI), takes a
 * playbook's `runner` (founder decision, proposal 72fdca0b; spec document
 * 7111934d §2.5, slice 2).
 *
 * A runner is one choice or an ordered list of fallbacks
 * (`PlaybookRunner`, `@synap/playbooks`). Each choice is EXPANDED into
 * candidates from the roster the hand-off doors already read
 * (`readAgentsForHandoff`): an agent by id; a role (`users.agent_role`, or one
 * of the agent's preset keys); an engine (`users.agent_type`); narrowed to a
 * computer by name or id (`matchComputer`, the installations door's rule).
 * Whether a candidate may take the person's work is THE route's answer, read
 * through the roster (`canTakeYourWork`, from `namedVerdicts`); whether it can
 * work now is the roster's wake mark (`deriveAgentWake`). No second router.
 *
 * Choosing, first match wins:
 *   1. among the AWAKE candidates the route admits, in order, the first whose
 *      computer has every tool the playbook `requires` installed;
 *   2. none has them all: the first awake one, with what it lacks (asking for
 *      the installs is the stage runner's job, slice 3);
 *   3. nobody: `chosen: null`, and the caller goes on to its next rung.
 * Every candidate that could not take it is recorded in order, with why
 * (`RunnerPassedOver`), so the run can say who was passed over.
 *
 * Synap AI's tools are `unverified` (whether a capability is enabled on the
 * pod is not read here yet), never `missing`; an agent on no known computer
 * likewise. Read-only.
 */

import { and, db, inArray, isNotNull } from "@synap/database";
import { agentConfigs, users } from "@synap/database/schema";
import type {
  RunnerPassedOver,
  RunnerRequiresState,
} from "@synap-core/types/agents";
import {
  runnerChoices,
  type PlaybookRunner,
  type PlaybookRunnerRef,
} from "@synap/playbooks";
import {
  listComputerOwnInstallations,
  type ComputerRef,
} from "../installations/installations.js";
import {
  listPersonsComputers,
  matchComputer,
} from "../installations/request-installation.js";
import {
  readAgentsForHandoff,
  type HandoffAgent,
} from "./agents-for-handoff.js";

/** The runner that takes it. */
export type ResolvedRunnerChoice =
  | {
      kind: "synap_ai";
      /** `{ synapAi: { persona } }`: the persona (`agents.slug`) to run as. */
      persona: string | null;
      requires: Record<string, RunnerRequiresState>;
      /** Its position in the runner list. */
      choice: number;
    }
  | {
      kind: "agent";
      agentUserId: string;
      name: string | null;
      reach: "pull" | "dispatch";
      /** The agent's computer (`users.host_user_id`); null = none known. */
      computerUserId: string | null;
      /** The preset the choice named, or the one its role matched. */
      preset: string | null;
      requires: Record<string, RunnerRequiresState>;
      /** The required tools its computer does not have. */
      missing: string[];
      choice: number;
    };

export interface ResolvedRunner {
  /** Who takes it; `null` = no choice could (the caller's next rung). */
  chosen: ResolvedRunnerChoice | null;
  /** Each choice or candidate that could not take it, in order. */
  passedOver: RunnerPassedOver[];
}

/** One candidate a choice expanded to, before the route and wake are read. */
interface Candidate {
  choice: number;
  agent: HandoffAgent;
  preset: string | null;
}

/** Roles and preset keys of the roster's agents, read once. */
async function loadRoles(agentIds: readonly string[]): Promise<{
  role: Map<string, string | null>;
  presets: Map<string, Set<string>>;
}> {
  if (agentIds.length === 0) return { role: new Map(), presets: new Map() };
  const [roleRows, presetRows] = await Promise.all([
    db
      .select({ id: users.id, role: users.agentRole })
      .from(users)
      .where(inArray(users.id, [...agentIds])),
    db
      .select({ userId: agentConfigs.userId, key: agentConfigs.presetKey })
      .from(agentConfigs)
      .where(
        and(
          inArray(agentConfigs.userId, [...agentIds]),
          isNotNull(agentConfigs.presetKey)
        )
      ),
  ]);
  const presets = new Map<string, Set<string>>();
  for (const r of presetRows) {
    if (!r.key) continue;
    const set = presets.get(r.userId) ?? new Set<string>();
    set.add(r.key);
    presets.set(r.userId, set);
  }
  return {
    role: new Map(roleRows.map((r) => [r.id, r.role ?? null])),
    presets,
  };
}

function needsRoster(choices: readonly PlaybookRunnerRef[]): boolean {
  return choices.some(
    (c) =>
      typeof c === "object" && ("agentId" in c || "role" in c || "engine" in c)
  );
}

/**
 * The tools `requires` lists, as found on `computerUserId`. No computer, or
 * one that is not among the person's, reads `unverified` for every tool.
 */
async function requiresOn(
  requires: readonly string[],
  computerUserId: string | null,
  computers: () => Promise<ComputerRef[]>
): Promise<Record<string, RunnerRequiresState>> {
  if (requires.length === 0) return {};
  const unverified = Object.fromEntries(
    requires.map((k) => [k, "unverified" as const])
  );
  if (!computerUserId) return unverified;
  const computer = (await computers()).find((c) => c.id === computerUserId);
  if (!computer) return unverified;
  const installed = new Set(
    (await listComputerOwnInstallations(computer))
      .filter((i) => i.status === "installed")
      .map((i) => i.capabilityKey)
  );
  return Object.fromEntries(
    requires.map((k) => [
      k,
      installed.has(k) ? ("installed" as const) : ("missing" as const),
    ])
  );
}

/**
 * The tools `requires` lists, on the person's computer `computerUserId`
 * (`null` = none known, or Synap AI: every tool `unverified`). The one check
 * the stage runner (`enterStage`) and its re-check read, the same as a
 * runner choice is judged by here.
 */
export async function requiresOnComputer(p: {
  ownerId: string;
  requires: readonly string[];
  computerUserId: string | null;
}): Promise<Record<string, RunnerRequiresState>> {
  return requiresOn([...new Set(p.requires)], p.computerUserId, () =>
    listPersonsComputers(p.ownerId)
  );
}

export async function resolveRunner(p: {
  ownerId: string;
  runner: PlaybookRunner | null | undefined;
  /** The capability keys every candidate's computer is checked for. */
  requires?: readonly string[] | null;
  /** Synap AI may run it (the playbook's executor is not `external-agent`). */
  synapAiAllowed: boolean;
}): Promise<ResolvedRunner> {
  // "self" names the run's own agent: at the playbook level, nobody.
  const choices = runnerChoices(p.runner).filter((c) => c !== "self");
  const requires = [...new Set(p.requires ?? [])];
  const passedOver: RunnerPassedOver[] = [];
  if (choices.length === 0) return { chosen: null, passedOver };

  const roster = needsRoster(choices)
    ? await readAgentsForHandoff(p.ownerId)
    : { agents: [] as HandoffAgent[], computers: [] };
  const theirs = roster.agents.filter((a) => a.reach !== "pod");
  const { role, presets } = needsRoster(choices)
    ? await loadRoles(theirs.map((a) => a.agentUserId))
    : { role: new Map(), presets: new Map() };
  let computersRead: Promise<ComputerRef[]> | null = null;
  const computers = () => (computersRead ??= listPersonsComputers(p.ownerId));

  /** The agents a role/engine choice keeps on the named computer. */
  const onComputer = async (
    agents: HandoffAgent[],
    ref: string | undefined
  ): Promise<HandoffAgent[]> => {
    if (!ref) return agents;
    const match = matchComputer(await computers(), ref);
    if (match.status !== "found") return [];
    return agents.filter((a) => a.computer?.agentUserId === match.computer.id);
  };

  // 1. Expand every choice, in order, into Synap AI or candidate agents.
  type Awake =
    | { kind: "synap_ai"; choice: number; persona: string | null }
    | { kind: "agent"; c: Candidate };
  const awake: Awake[] = [];
  const seen = new Set<string>();
  for (const [index, choice] of choices.entries()) {
    if (
      choice === "synap_ai" ||
      (typeof choice === "object" && "synapAi" in choice)
    ) {
      if (!p.synapAiAllowed) {
        passedOver.push({
          choice: index,
          agentUserId: null,
          name: null,
          why: "not_allowed",
        });
        continue;
      }
      awake.push({
        kind: "synap_ai",
        choice: index,
        persona:
          typeof choice === "object" && "synapAi" in choice
            ? choice.synapAi.persona
            : null,
      });
      continue;
    }
    if (typeof choice !== "object") continue;
    let candidates: Candidate[] = [];
    if ("agentId" in choice) {
      const agent = theirs.find((a) => a.agentUserId === choice.agentId);
      if (agent) {
        candidates = [{ choice: index, agent, preset: choice.preset ?? null }];
      }
    } else if ("role" in choice) {
      const fits = theirs.filter(
        (a) =>
          role.get(a.agentUserId) === choice.role ||
          presets.get(a.agentUserId)?.has(choice.role)
      );
      candidates = (await onComputer(fits, choice.computer)).map((agent) => ({
        choice: index,
        agent,
        // A role met by a preset runs as that preset; by `agent_role`, as is.
        preset:
          role.get(agent.agentUserId) === choice.role ? null : choice.role,
      }));
    } else if ("engine" in choice) {
      const fits = theirs.filter((a) => a.agentType === choice.engine);
      candidates = (await onComputer(fits, choice.computer)).map((agent) => ({
        choice: index,
        agent,
        preset: null,
      }));
    }
    if (candidates.length === 0) {
      passedOver.push({
        choice: index,
        agentUserId: null,
        name: null,
        why: "no_agent",
      });
      continue;
    }
    for (const c of candidates) {
      if (seen.has(c.agent.agentUserId)) continue;
      seen.add(c.agent.agentUserId);
      if (
        !c.agent.canTakeYourWork ||
        (c.agent.reach !== "pull" && c.agent.reach !== "dispatch")
      ) {
        passedOver.push({
          choice: index,
          agentUserId: c.agent.agentUserId,
          name: c.agent.name,
          why: "refused",
        });
        continue;
      }
      if (c.agent.wake.state !== "awake") {
        passedOver.push({
          choice: index,
          agentUserId: c.agent.agentUserId,
          name: c.agent.name,
          why: c.agent.wake.why ?? "not_awake",
        });
        continue;
      }
      awake.push({ kind: "agent", c });
    }
  }
  if (awake.length === 0) return { chosen: null, passedOver };

  // 2. Each awake one's tools, then the first that has them all.
  const withTools = await Promise.all(
    awake.map(async (a) => {
      const report =
        a.kind === "synap_ai"
          ? await requiresOn(requires, null, computers)
          : await requiresOn(
              requires,
              a.c.agent.computer?.agentUserId ?? null,
              computers
            );
      const missing = Object.entries(report)
        .filter(([, state]) => state !== "installed")
        .map(([key]) => key);
      return { a, report, missing };
    })
  );
  const complete = withTools.findIndex((w) => w.missing.length === 0);
  const pick = complete === -1 ? 0 : complete;
  for (const w of withTools.slice(0, pick)) {
    passedOver.push({
      choice: w.a.kind === "synap_ai" ? w.a.choice : w.a.c.choice,
      agentUserId: w.a.kind === "synap_ai" ? null : w.a.c.agent.agentUserId,
      name: w.a.kind === "synap_ai" ? null : w.a.c.agent.name,
      why: "missing_tools",
    });
  }
  const chosen = withTools[pick]!;
  if (chosen.a.kind === "synap_ai") {
    return {
      chosen: {
        kind: "synap_ai",
        persona: chosen.a.persona,
        requires: chosen.report,
        choice: chosen.a.choice,
      },
      passedOver,
    };
  }
  const { agent, preset, choice } = chosen.a.c;
  return {
    chosen: {
      kind: "agent",
      agentUserId: agent.agentUserId,
      name: agent.name,
      reach: agent.reach as "pull" | "dispatch",
      computerUserId: agent.computer?.agentUserId ?? null,
      preset,
      requires: chosen.report,
      // Only what is really absent; an unverified tool is not asked for.
      missing: Object.entries(chosen.report)
        .filter(([, state]) => state === "missing")
        .map(([key]) => key),
      choice,
    },
    passedOver,
  };
}
