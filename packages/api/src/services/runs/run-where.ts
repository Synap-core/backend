/**
 * WHERE A RUN RAN — derived at read time, never stored (computers plan v2
 * §0.5: "Where code runs stays `skills.execution_mode`. The 'where' of
 * anything else is derived and shown, never stored a second time"; plan v1
 * W3.6). No placement column beside `executor`: each run's where is read from
 * what already records it.
 *
 *   - a BOX run (`box_runs`, a capability run): the computer holding its lease
 *     (`box_runs.leased_by`); still queued → unknown (`null`);
 *   - a SESSION or PLAYBOOK run: the computer of the newest `session_runners`
 *     row that names one (the process that held its wait, 0373/0384); else
 *     its first roster agent's place (below); nobody on it → unknown;
 *   - an AGENT WRITE: the writing agent's place;
 *   - an automation, a capture, a chat turn, any other capability run: the
 *     pod ran it (`pod`).
 *
 * An agent's place: its computer (`users.host_user_id`); else `pod` for an
 * agent the pod runs (reach `pod`); else `outside` (an outside client with no
 * computer of record).
 *
 * A failed read leaves `where` ABSENT on every run of the page (and is
 * logged): absent = not read, `null` = nothing records where. The runs read
 * itself never fails for it.
 */
import { and, db, desc, eq, inArray, isNotNull } from "@synap/database";
import {
  boxRuns,
  focusSessions,
  playbookRuns,
  sessionRunners,
  users,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import type { RunWhere } from "@synap-core/types/computers";
import { createLogger } from "@synap-core/core";
import { resolveAgentReachMany } from "../agent-dispatch/agent-binding.js";
import { machineName } from "../machine-roster.js";
import type { UnifiedRun } from "./types.js";

const logger = createLogger({ module: "run-where" });

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POD: RunWhere = { kind: "pod", computer: null };

/** What the derivation reads, loaded once per page. */
export interface RunWhereFacts {
  /** box run id → the computer holding its lease (null while queued). */
  boxLease: Map<string, string | null>;
  /** session id → the newest runner row's computer. */
  sessionRunnerComputer: Map<string, string>;
  /** session id → its roster agents, in roster order. */
  sessionAgents: Map<string, string[]>;
  /** playbook run id → its session. */
  playbookSession: Map<string, string>;
  /** agent id → its computer (`host_user_id`), when it has one. */
  agentHost: Map<string, string>;
  /** agent id → reach (`pull` | `pod` | `dispatch`); agent users only. */
  agentReach: Map<string, string>;
  /** computer id → what the run's where names. */
  computers: Map<string, NonNullable<RunWhere["computer"]>>;
}

function computerWhere(facts: RunWhereFacts, computerId: string): RunWhere {
  return {
    kind: "computer",
    computer: facts.computers.get(computerId) ?? {
      id: computerId,
      name: "",
      belongsTo: null,
    },
  };
}

/**
 * An agent's place: its computer, else the pod for a pod agent, else outside.
 * Not an agent user (a person, a deleted row): unknown.
 */
function agentWhere(facts: RunWhereFacts, agentId: string): RunWhere | null {
  const host = facts.agentHost.get(agentId);
  if (host) return computerWhere(facts, host);
  const reach = facts.agentReach.get(agentId);
  if (!reach) return null;
  return reach === "pod" ? POD : { kind: "outside", computer: null };
}

function sessionWhere(
  facts: RunWhereFacts,
  sessionId: string | undefined
): RunWhere | null {
  if (!sessionId) return null;
  const runner = facts.sessionRunnerComputer.get(sessionId);
  if (runner) return computerWhere(facts, runner);
  const first = facts.sessionAgents.get(sessionId)?.[0];
  return first ? agentWhere(facts, first) : null;
}

/** THE derivation, pure over the loaded facts. */
export function deriveRunWhere(
  run: Pick<UnifiedRun, "id" | "flowType" | "triggeredBy">,
  facts: RunWhereFacts
): RunWhere | null {
  switch (run.flowType) {
    case "capability": {
      return POD;
      const lease = facts.boxLease.get(run.id);
      return lease ? computerWhere(facts, lease) : null;
    }
    case "session":
      return sessionWhere(facts, run.id);
    case "playbook":
      return sessionWhere(facts, facts.playbookSession.get(run.id));
    case "agent_write":
      return run.triggeredBy ? agentWhere(facts, run.triggeredBy) : null;
    default:
      // automation, capture, chat: the pod's own engine ran it.
      return POD;
  }
}

/** Load every fact the page's runs need, in a bounded number of reads. */
export async function loadRunWhereFacts(
  runs: readonly Pick<UnifiedRun, "id" | "flowType" | "triggeredBy">[]
): Promise<RunWhereFacts> {
  const ids = (f: UnifiedRun["flowType"]) =>
    runs
      .filter((r) => r.flowType === f && UUID_SHAPE.test(r.id))
      .map((r) => r.id);
  const capabilityIds = ids("capability");
  const playbookRunIds = ids("playbook");

  const [leases, playbookRows] = await Promise.all([
    capabilityIds.length
      ? db
          .select({ id: boxRuns.id, leasedBy: boxRuns.leasedBy })
          .from(boxRuns)
          .where(inArray(boxRuns.id, capabilityIds))
      : [],
    playbookRunIds.length
      ? db
          .select({ id: playbookRuns.id, sessionId: playbookRuns.sessionId })
          .from(playbookRuns)
          .where(inArray(playbookRuns.id, playbookRunIds))
      : [],
  ]);
  const playbookSession = new Map<string, string>();
  for (const p of playbookRows)
    if (p.sessionId) playbookSession.set(p.id, p.sessionId);

  const sessionIds = [
    ...new Set([...ids("session"), ...playbookSession.values()]),
  ];
  const [runnerRows, sessionRows] = await Promise.all([
    sessionIds.length
      ? db
          .select({
            sessionId: sessionRunners.sessionId,
            machineUserId: sessionRunners.machineUserId,
          })
          .from(sessionRunners)
          .where(
            and(
              inArray(sessionRunners.sessionId, sessionIds),
              isNotNull(sessionRunners.machineUserId)
            )
          )
          .orderBy(desc(sessionRunners.lastSeenAt))
      : [],
    sessionIds.length
      ? db
          .select({ id: focusSessions.id, agentIds: focusSessions.agentIds })
          .from(focusSessions)
          .where(inArray(focusSessions.id, sessionIds))
      : [],
  ]);
  const sessionRunnerComputer = new Map<string, string>();
  for (const r of runnerRows)
    if (r.machineUserId && !sessionRunnerComputer.has(r.sessionId))
      sessionRunnerComputer.set(r.sessionId, r.machineUserId);
  const sessionAgents = new Map<string, string[]>();
  for (const s of sessionRows) sessionAgents.set(s.id, s.agentIds ?? []);

  const agentIds = [
    ...new Set([
      ...runs
        .filter((r) => r.flowType === "agent_write" && r.triggeredBy)
        .map((r) => r.triggeredBy!),
      ...[...sessionAgents.values()].map((a) => a[0]).filter((a) => !!a),
    ]),
  ];
  const [agentRows, reach] = await Promise.all([
    agentIds.length
      ? db
          .select({
            id: users.id,
            userType: users.userType,
            agentType: users.agentType,
            hostUserId: users.hostUserId,
          })
          .from(users)
          .where(inArray(users.id, agentIds))
      : [],
    resolveAgentReachMany(agentIds),
  ]);
  const agentHost = new Map<string, string>();
  const agentReach = new Map<string, string>();
  for (const a of agentRows) {
    if (a.userType !== "agent") continue;
    agentReach.set(a.id, reach.get(a.id) ?? "pull");
    // A computer's own key acting is the computer itself.
    if (a.agentType === MACHINE_AGENT_TYPE) agentHost.set(a.id, a.id);
    else if (a.hostUserId) agentHost.set(a.id, a.hostUserId);
  }

  const computerIds = [
    ...new Set([
      ...leases.map((l) => l.leasedBy).filter((c): c is string => !!c),
      ...sessionRunnerComputer.values(),
      ...agentHost.values(),
    ]),
  ];
  const computerRows = computerIds.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          agentMetadata: users.agentMetadata,
          belongsTo: users.computerBelongsTo,
        })
        .from(users)
        .where(
          and(
            inArray(users.id, computerIds),
            eq(users.agentType, MACHINE_AGENT_TYPE)
          )
        )
    : [];
  const computers = new Map<string, NonNullable<RunWhere["computer"]>>();
  for (const c of computerRows)
    computers.set(c.id, {
      id: c.id,
      name: machineName(c),
      belongsTo: c.belongsTo ?? null,
    });

  return {
    boxLease: new Map(leases.map((l) => [l.id, l.leasedBy ?? null])),
    sessionRunnerComputer,
    sessionAgents,
    playbookSession,
    agentHost,
    agentReach,
    computers,
  };
}

/**
 * Each run with its `where`. On a failed read the runs come back WITHOUT the
 * field (logged): not read, never "unknown" and never "the pod".
 */
export async function withRunWhere<T extends UnifiedRun>(
  runs: T[]
): Promise<T[]> {
  if (runs.length === 0) return runs;
  try {
    const facts = await loadRunWhereFacts(runs);
    return runs.map((r) => ({ ...r, where: deriveRunWhere(r, facts) }));
  } catch (err) {
    logger.warn({ err }, "run-where: read failed; runs carry no where");
    return runs;
  }
}
