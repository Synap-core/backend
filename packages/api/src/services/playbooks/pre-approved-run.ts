/**
 * PRE-APPROVED AGENT RUNS (founder decision, 10 Nov 2026, proposal a01b9d46;
 * plan fbfadf54 §6): a person lets their agents run ONE playbook without
 * asking.
 *
 * The approval is a `governance_rules` row naming that playbook at its version
 * and the person whose agents it covers (0420), matched by the one governance
 * door (`checkPermissionOrPropose` → `resolveGovernanceRule`); the grant then
 * carries `preApprovedByRuleId`. An agent's run is held as the person's draft
 * (B6, `runPlaybook`) unless that rule decided, still names the version the
 * run starts, AND the playbook is eligible ({@link preApprovalEligibility}):
 *  - every `tools` entry (the playbook's and each step's) is a run tool on the
 *    pod's own data, and no `grants` link names a capability (a capability or
 *    a web read can reach outside the pod; links do not bump the version the
 *    rule is pinned to);
 *  - the run is not handed to an agent or a computer, the playbook does not
 *    run on agents (`executor`), and every runner (the playbook's or a step's)
 *    is the pod's own AI (`runsOnPodAi`);
 *  - no step IS another playbook (`uses`): that playbook was not allowed.
 * Any of these fails → held as before, with a reason the reply names and the
 * draft keeps (`metadata.triage.heldBecause`). Space `taskIntents` are not the
 * playbook's declaration; a capability they offer still meets the outward
 * floor (`capability.run`) on every call.
 */
import { and, eq, ne, governanceRules, type getDb } from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import { isPodDataRunTool, readToolsList, runsOnPodAi } from "@synap/playbooks";
import {
  PLAYBOOK_RUN_ACTION,
  type PreApprovalHeldReason,
  type PreApprovalIneligibleReason,
} from "@synap-core/types/governance-rules";
import { createLogger } from "@synap-core/core";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";
import { activeRulePredicate } from "../../utils/governance-rule-reads.js";

const logger = createLogger({ module: "pre-approved-run" });

type Db = Awaited<ReturnType<typeof getDb>>;

export type { PreApprovalHeldReason, PreApprovalIneligibleReason };

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

/** May a run of this playbook start on a person's pre-approval? */
export type PreApprovalEligibility =
  | { eligible: true; reason: null }
  | { eligible: false; reason: PreApprovalIneligibleReason };

export type PreApprovalDecision =
  | { runs: true; ruleId: string }
  | { runs: false; reason?: PreApprovalHeldReason };

type PreApprovablePlaybook = Pick<
  Playbook,
  "id" | "version" | "executor" | "runner" | "stages" | "tools"
>;

function stagesOf(stages: unknown): Array<Record<string, unknown>> {
  return Array.isArray(stages)
    ? stages.filter(
        (s): s is Record<string, unknown> => !!s && typeof s === "object"
      )
    : [];
}

const ineligible = (
  reason: PreApprovalIneligibleReason
): PreApprovalEligibility => ({ eligible: false, reason });

/**
 * THE eligibility of a playbook for a pre-approved agent run: read by the run
 * ({@link decidePreApprovedRun}) and by `governanceRules.forSubject`, so the
 * page offering the approval says what the run will do.
 */
export async function preApprovalEligibility(p: {
  playbook: PreApprovablePlaybook;
  userId: string;
  /** The run is handed to an agent (`resolveRunChoice`'s `handOff`). */
  handedOff?: boolean;
}): Promise<PreApprovalEligibility> {
  const { playbook } = p;
  const stages = stagesOf(playbook.stages);
  if (
    p.handedOff ||
    playbook.executor === "external-agent" ||
    !runsOnPodAi(playbook.runner) ||
    stages.some((s) => !runsOnPodAi(s.runner))
  ) {
    return ineligible("runs_elsewhere");
  }
  if (stages.some((s) => s.uses != null)) {
    return ineligible("runs_other_playbook");
  }
  const declared = [
    ...readToolsList(playbook.tools),
    ...stages.flatMap((s) => readToolsList(s.tools)),
  ];
  if (declared.some((t) => !isPodDataRunTool(t))) {
    return ineligible("declares_tools");
  }
  try {
    const links = await getLinksFor(p.userId, "playbook", playbook.id);
    const granted = await resolveGrantedCapabilities(links, {
      linkType: "grants",
      fromType: "playbook",
    });
    if (granted.length > 0) return ineligible("declares_tools");
  } catch (err) {
    logger.warn(
      { err, playbookId: playbook.id },
      "pre-approved run: could not read the playbook's granted capabilities"
    );
    return ineligible("could_not_check");
  }
  return { eligible: true, reason: null };
}

/**
 * Does this agent run start without the person's click? `preApprovedByRuleId`
 * is the grant's (`checkPermissionOrPropose`); absent, the run is held, and
 * the reason says so when the person's rule names an earlier version. The
 * rule is read again here: the playbook may have changed between the run
 * door's check and this start, and a rule never covers another version.
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
  const ruleId = p.preApprovedByRuleId;
  const personsRule = and(
    activeRulePredicate(),
    eq(governanceRules.targetPattern, PLAYBOOK_RUN_ACTION),
    eq(governanceRules.verdict, "auto"),
    eq(governanceRules.targetSubjectId, playbook.id),
    eq(governanceRules.principalOwnerId, p.userId)
  );
  let rule: { version: number | null } | undefined;
  try {
    [rule] = await db
      .select({ version: governanceRules.targetSubjectVersion })
      .from(governanceRules)
      .where(
        and(
          personsRule,
          ruleId
            ? eq(governanceRules.id, ruleId)
            : ne(governanceRules.targetSubjectVersion, playbook.version)
        )
      )
      .limit(1);
  } catch (err) {
    logger.warn(
      { err, playbookId: playbook.id },
      "pre-approved run: could not read the person's rule for this playbook"
    );
    return { runs: false, reason: "could_not_check" };
  }
  if (!ruleId) {
    return rule ? { runs: false, reason: "version_changed" } : { runs: false };
  }
  // Gone since the door's check (revoked, replaced): held, as with no rule.
  if (!rule) return { runs: false };
  if (rule.version !== playbook.version) {
    return { runs: false, reason: "version_changed" };
  }
  const eligibility = await preApprovalEligibility({
    playbook,
    userId: p.userId,
    handedOff: p.handedOff,
  });
  return eligibility.eligible
    ? { runs: true, ruleId }
    : { runs: false, reason: eligibility.reason };
}
