/**
 * PRE-APPROVED AGENT RUNS (founder decision, 10 Nov 2026, proposal a01b9d46;
 * plan fbfadf54 §6): a person lets agents run ONE playbook without asking.
 *
 * The approval is a `governance_rules` row naming that playbook at its version
 * (0420), matched by the one governance door (`checkPermissionOrPropose` →
 * `resolveGovernanceRule`); the grant then carries `preApprovedByRuleId`. An
 * agent's run is held as the person's draft (B6, `runPlaybook`) unless that
 * rule decided AND the run stays what the person allowed: work on pod data by
 * the pod's own AI. This file is the second half, checked when the run starts:
 *  - the playbook declares no capability (no `grants` link, no step grant, no
 *    `requiredIntents`): a capability can reach outside the pod, and grants
 *    are links, which do not bump the version the rule is pinned to;
 *  - the run is not handed to an agent or a computer, the playbook does not
 *    run on agents (`executor`), and no runner (the playbook's or a step's)
 *    names anyone but Synap AI;
 *  - no step IS another playbook (`uses`): that playbook was not allowed.
 * Any of these fails → held as before, with a reason the reply names. Space
 * `taskIntents` are not the playbook's declaration; a capability they offer
 * still meets the outward floor (`capability.run`) on every call.
 */
import {
  and,
  eq,
  gt,
  isNull,
  ne,
  or,
  governanceRules,
  type getDb,
} from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import {
  readRequiredIntents,
  runnerChoices,
  type PlaybookRunner,
} from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";

const logger = createLogger({ module: "pre-approved-run" });

type Db = Awaited<ReturnType<typeof getDb>>;

/** Why an agent's run of a pre-approved playbook is still held. */
export type PreApprovalHeldReason =
  | "version_changed"
  | "declares_tools"
  | "runs_elsewhere"
  | "runs_other_playbook"
  | "could_not_check";

/** The line the run reply adds for the agent (tool text, never translated). */
export const PRE_APPROVAL_HELD_LINE: Record<PreApprovalHeldReason, string> = {
  version_changed:
    "The person let agents run an earlier version of this playbook; it changed since, so it asks again.",
  declares_tools:
    "The person let agents run this playbook, but it uses tools beyond the pod's own data, so it still asks.",
  runs_elsewhere:
    "The person let agents run this playbook, but this run goes to another agent or computer, so it still asks.",
  runs_other_playbook:
    "The person let agents run this playbook, but one of its steps runs another playbook, so it still asks.",
  could_not_check:
    "Whether this run may start without asking could not be checked, so it asks.",
};

export type PreApprovalDecision =
  | { runs: true; ruleId: string }
  | { runs: false; reason?: PreApprovalHeldReason };

type PreApprovablePlaybook = Pick<
  Playbook,
  "id" | "version" | "executor" | "runner" | "stages" | "requiredIntents"
>;

/** Only Synap AI: no runner, or every choice is the pod's own AI. */
function runsOnPodAi(runner: unknown): boolean {
  return runnerChoices(runner as PlaybookRunner | null | undefined).every(
    (c) => c === "synap_ai" || (typeof c === "object" && "synapAi" in c)
  );
}

function stagesOf(stages: unknown): Array<Record<string, unknown>> {
  return Array.isArray(stages)
    ? stages.filter(
        (s): s is Record<string, unknown> => !!s && typeof s === "object"
      )
    : [];
}

/**
 * Does this agent run start without the person's click? `preApprovedByRuleId`
 * is the grant's (`checkPermissionOrPropose`); absent, the run is held, and
 * the reason says so when a rule names an earlier version of the playbook.
 */
export async function decidePreApprovedRun(p: {
  db: Db;
  playbook: PreApprovablePlaybook;
  preApprovedByRuleId: string | undefined;
  /** The run is handed to an agent (`resolveRunChoice`'s `handOff`). */
  handedOff: boolean;
  userId: string;
}): Promise<PreApprovalDecision> {
  const { db, playbook } = p;
  if (!p.preApprovedByRuleId) {
    try {
      const [stale] = await db
        .select({ id: governanceRules.id })
        .from(governanceRules)
        .where(
          and(
            isNull(governanceRules.revokedAt),
            or(
              isNull(governanceRules.expiresAt),
              gt(governanceRules.expiresAt, new Date())
            ),
            eq(governanceRules.targetPattern, "playbook.run"),
            eq(governanceRules.verdict, "auto"),
            eq(governanceRules.targetSubjectId, playbook.id),
            ne(governanceRules.targetSubjectVersion, playbook.version)
          )
        )
        .limit(1);
      return stale
        ? { runs: false, reason: "version_changed" }
        : { runs: false };
    } catch (err) {
      logger.warn(
        { err, playbookId: playbook.id },
        "pre-approved run: could not read whether an earlier version was allowed"
      );
      return { runs: false, reason: "could_not_check" };
    }
  }

  const stages = stagesOf(playbook.stages);
  if (
    p.handedOff ||
    playbook.executor === "external-agent" ||
    !runsOnPodAi(playbook.runner) ||
    stages.some((s) => !runsOnPodAi(s.runner))
  ) {
    return { runs: false, reason: "runs_elsewhere" };
  }
  if (stages.some((s) => s.uses != null)) {
    return { runs: false, reason: "runs_other_playbook" };
  }
  if (
    readRequiredIntents(playbook).length > 0 ||
    stages.some((s) => Array.isArray(s.grants) && s.grants.length > 0)
  ) {
    return { runs: false, reason: "declares_tools" };
  }
  try {
    const links = await getLinksFor(p.userId, "playbook", playbook.id);
    const granted = await resolveGrantedCapabilities(links, {
      linkType: "grants",
      fromType: "playbook",
    });
    if (granted.length > 0) return { runs: false, reason: "declares_tools" };
  } catch (err) {
    logger.warn(
      { err, playbookId: playbook.id },
      "pre-approved run: could not read the playbook's granted capabilities"
    );
    return { runs: false, reason: "could_not_check" };
  }
  return { runs: true, ruleId: p.preApprovedByRuleId };
}
