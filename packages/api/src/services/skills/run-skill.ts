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
  const startTime = Date.now();
  const [row] = await db
    .select({ executionMode: skills.executionMode })
    .from(skills)
    .where(eq(skills.id, args.skillId))
    .limit(1);
  // Files as bytes reach a provider only through the pod sandbox's bridges
  // (`podFiles`): a box script and the IS rollback have none, so the run is
  // refused rather than handed handles nothing can resolve.
  const bytesRefused = (where: string) => ({
    success: false as const,
    error: `This run carries files as bytes, which ${where} cannot send. Nothing was sent.`,
    executionTimeMs: 0,
  });
  if (row?.executionMode === "box") {
    if (args.podFiles) return bytesRefused("a box script");
    if (args.dryRun) {
      return { success: false, error: BOX_NO_PREVIEW, executionTimeMs: 0 };
    }
    const queued = await enqueueBoxRun({
      skillId: args.skillId,
      parameters: args.parameters,
      userId: args.userId,
      agentUserId: args.agentUserId ?? args.provenance?.agentUserId ?? null,
      sessionId: args.sessionId ?? null,
      workspaceId: args.workspaceId ?? null,
      proposalId: args.provenance?.proposalId ?? null,
    });
    return queued.ok
      ? {
          success: true,
          result: queued.result,
          executionTimeMs: Date.now() - startTime,
        }
      : {
          success: false,
          error: queued.error,
          executionTimeMs: Date.now() - startTime,
        };
  }

  const { provenance: _provenance, ...runArgs } = args;
  if (skillRuntime() === "pod") return runSkillInSandbox(runArgs);
  if (args.podFiles) return bytesRefused("the Intelligence Service runtime");
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
