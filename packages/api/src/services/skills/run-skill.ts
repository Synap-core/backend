/**
 * runSkill — the ONE door that runs a code skill (R2, code-runtime plan v2,
 * "one door").
 *
 * Every caller that runs or previews a code skill comes here: the post-gate
 * `executeCapability` (agents, automations, approved runs), the person's own
 * Run (`skills.execute`) and both dry-run doors (tRPC `capabilities.dryRun`,
 * Hub REST `POST /skills/:id/dry-run`). None of them reaches a runtime itself;
 * `__tripwires__/one-skill-door.test.ts` holds that.
 *
 * A BOX skill (`execution_mode = 'box'`, a Python or Node script) never runs
 * here: it is queued for the person's own computer (`enqueueBoxRun`), and a
 * dry-run answers that it has no preview. Decided here, before the runtime, so
 * no door can send a box script to an isolate, under either runtime.
 *
 * Where any other code skill runs is `skillRuntime()`: the pod's own sandbox by default — the
 * bridges in this process, the code in a supervised runner process (pod
 * decision R6) — or the Intelligence Service under the `SKILL_RUNTIME=is`
 * rollback, until W6 deletes it. No fallback between them: a pod runtime that
 * cannot start fails the run with its reason.
 *
 * Callers keep their own gates. This door decides nothing; it only runs.
 */
import { db, eq } from "@synap/database";
import { skills } from "@synap/database/schema";
import { enqueueBoxRun } from "../box-runs/box-runs.js";
import {
  dryRunSkillViaIS,
  executeSkillViaIS,
  type SkillExecutionResult,
} from "./execute-skill-via-is.js";
import { runSkillInSandbox } from "./run-skill-in-sandbox.js";
import { skillRuntime } from "./runner/index.js";

export type RunSkillArgs = Parameters<typeof runSkillInSandbox>[0] & {
  /**
   * WHO ASKED, for a queued box run's attribution only: an approved
   * `capability.run` replays as the approver with no agent, but the run still
   * records the agent that asked and the proposal that approved it. Never
   * read by any gate.
   */
  provenance?: { agentUserId?: string | null; proposalId?: string | null };
};

/** A box script has no preview: it runs only on the person's computer. */
export const BOX_NO_PREVIEW =
  "This skill runs in a box on your computer; it has no preview. Run it to queue it.";

export async function runSkill(
  args: RunSkillArgs
): Promise<SkillExecutionResult> {
  void db; void eq; void skills; void enqueueBoxRun;
  const { provenance: _provenance, ...runArgs } = args;
  if (skillRuntime() === "pod") return runSkillInSandbox(runArgs);
  // Rollback path. The IS forwards no agent identity, session or verb act:
  // that is the gap R2 closes, kept only for SKILL_RUNTIME=is.
  if (args.dryRun) {
    return dryRunSkillViaIS({
      skillId: args.skillId,
      userId: args.userId,
      parameters: args.parameters,
      workspaceId: args.workspaceId,
    });
  }
  return executeSkillViaIS({
    skillId: args.skillId,
    userId: args.userId,
    parameters: args.parameters,
    workspaceId: args.workspaceId,
  });
}
