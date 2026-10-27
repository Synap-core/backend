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
 * Where it runs is `skillRuntime()`: the pod's own sandbox by default — the
 * bridges in this process, the code in a supervised runner process (pod
 * decision R6) — or the Intelligence Service under the `SKILL_RUNTIME=is`
 * rollback, until W6 deletes it. No fallback between them: a pod runtime that
 * cannot start fails the run with its reason.
 *
 * Callers keep their own gates. This door decides nothing; it only runs.
 */
import {
  dryRunSkillViaIS,
  executeSkillViaIS,
  type SkillExecutionResult,
} from "./execute-skill-via-is.js";
import { runSkillInSandbox } from "./run-skill-in-sandbox.js";
import { skillRuntime } from "./runner/index.js";

export type RunSkillArgs = Parameters<typeof runSkillInSandbox>[0];

export async function runSkill(
  args: RunSkillArgs
): Promise<SkillExecutionResult> {
  if (skillRuntime() === "pod") return runSkillInSandbox(args);
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
