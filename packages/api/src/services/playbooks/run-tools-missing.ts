/**
 * A RUN WHOSE TOOLS LACK WHAT A STEP DECLARES NEVER STARTS (founder, 10 Nov
 * 2026; plan fbfadf54 fix 1a). Run 2a231408 ("Fix a finding") started, then
 * ended 12 s in because its worker had no tool for the step (finding
 * a9cc4848). The check runs before any session, room, run row or proposal.
 *
 * A step's `tools` entry is MISSING from a run on the pod's own AI when the
 * run resolves nothing for it, by the same rules as `run-tool-profile.ts`:
 *   - the run is one model call (`one-shot`): it has no tools at all;
 *   - the playbook's own `tools` does not list it (never offered at run time);
 *   - a run tool name is always offered; an intent slug needs a verb serving
 *     it on this pod; anything else needs a capability or verb the run's lens
 *     can see.
 *
 * Not checked: a run handed to an agent (it brings its own tools; its
 * computer is checked against `requires` by the runner), and a step whose
 * `runner` names someone other than the pod's AI.
 *
 * A FAILED registry read is not "missing": the check answers `unread` and the
 * run starts, where its profile says the tools could not be read.
 */
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { isKnownIntent } from "@synap-core/types/capability-intents";
import {
  isRunToolName,
  readToolsList,
  runClassOf,
  runnerChoices,
  type PlaybookRunner,
} from "@synap/playbooks";
import {
  defaultDeps,
  namedVerbs,
  type RunToolProfileDeps,
} from "./run-tool-profile.js";

const logger = createLogger({ module: "run-tools-missing" });

/** The machine code of the refusal (`error.data.reasonCode` on the wire). */
export const RUN_TOOLS_MISSING = "RUN_TOOLS_MISSING";

/** One step and the tools it declares that the run cannot use. */
export interface StageToolsMissing {
  stageKey: string;
  stageName: string;
  missing: string[];
}

export type RunToolsCheck =
  { status: "ok"; missing: StageToolsMissing[] } | { status: "unread" };

/** The playbook fields the check reads. */
export interface RunToolsPlaybook {
  name: string;
  executor: string | null;
  tools: unknown;
  stages: unknown;
}

/** Does every choice of this runner land on the pod's own AI? PURE. */
function runsOnPodAi(runner: unknown): boolean {
  return runnerChoices(runner as PlaybookRunner | undefined).every(
    (c) =>
      c === "self" ||
      c === "synap_ai" ||
      (typeof c === "object" && c !== null && "synapAi" in c)
  );
}

/** The steps a run on the pod's AI works that declare their own `tools`. PURE. */
function declaringStages(
  stages: unknown
): Array<{ key: string; name: string; tools: string[] }> {
  if (!Array.isArray(stages)) return [];
  const out: Array<{ key: string; name: string; tools: string[] }> = [];
  for (const s of stages) {
    if (!s || typeof s !== "object") continue;
    const stage = s as {
      key?: unknown;
      name?: unknown;
      tools?: unknown;
      runner?: unknown;
    };
    const tools = readToolsList(stage.tools);
    if (tools.length === 0 || !runsOnPodAi(stage.runner)) continue;
    const key = String(stage.key);
    out.push({
      key,
      name: typeof stage.name === "string" && stage.name ? stage.name : key,
      tools,
    });
  }
  return out;
}

/** Does a step a run on the pod's AI works declare its own `tools`? PURE. */
export function declaresStepTools(stages: unknown): boolean {
  return declaringStages(stages).length > 0;
}

/**
 * The steps whose declared tools a run of this playbook on the pod's own AI
 * cannot use, under the run's lens.
 */
export async function findRunToolsMissing(
  input: {
    playbook: RunToolsPlaybook;
    workspaceId: string | null;
    userId: string;
  },
  deps: Pick<RunToolProfileDeps, "readRegistry"> = defaultDeps
): Promise<RunToolsCheck> {
  const stages = declaringStages(input.playbook.stages);
  if (stages.length === 0) return { status: "ok", missing: [] };
  const oneShot = runClassOf(input.playbook) === "one-shot";
  const playbookTools = new Set(readToolsList(input.playbook.tools));
  const needsRegistry =
    !oneShot &&
    stages.some((s) =>
      s.tools.some((t) => playbookTools.has(t) && !isRunToolName(t))
    );
  let registry: Awaited<ReturnType<RunToolProfileDeps["readRegistry"]>> | null =
    null;
  if (needsRegistry) {
    try {
      registry = await deps.readRegistry({
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
    } catch (err) {
      logger.error(
        { err, workspaceId: input.workspaceId },
        "run-tools-missing: the registry could not be read — the run's step tools are unchecked"
      );
      return { status: "unread" };
    }
  }
  const usable = (entry: string): boolean => {
    if (oneShot || !playbookTools.has(entry)) return false;
    if (isRunToolName(entry)) return true;
    if (!registry) return false;
    if (isKnownIntent(entry)) {
      return (registry.index.get(entry)?.length ?? 0) > 0;
    }
    return namedVerbs([entry], registry.capabilities).length > 0;
  };
  const missing: StageToolsMissing[] = [];
  for (const s of stages) {
    const lacking = s.tools.filter((t) => !usable(t));
    if (lacking.length > 0) {
      missing.push({ stageKey: s.key, stageName: s.name, missing: lacking });
    }
  }
  return { status: "ok", missing };
}

/** "step "A" needs x, y; step "B" needs z". PURE. */
function stepsLacking(missing: readonly StageToolsMissing[]): string {
  return missing
    .map((m) => `step "${m.stageName}" needs ${m.missing.join(", ")}`)
    .join("; ");
}

/** The refusal sentence of a run that cannot start. PURE. */
export function describeRunToolsMissing(
  playbookName: string,
  missing: readonly StageToolsMissing[]
): string {
  return `"${playbookName}" cannot run here: its ${stepsLacking(missing)}, which a run on this pod cannot use. Nothing was started. Hand the run to an agent that has these tools, add a capability that serves them, or take them off the step.`;
}

/**
 * What the playbook write door warns about (never a refusal): a step whose
 * tools a run on this pod's AI cannot use, so its runs would refuse to start.
 */
export async function runToolsSaveWarnings(
  input: {
    playbook: RunToolsPlaybook;
    workspaceId: string | null;
    userId: string;
  },
  deps?: Pick<RunToolProfileDeps, "readRegistry">
): Promise<string[]> {
  const check = await findRunToolsMissing(input, deps);
  if (check.status === "unread") {
    return [
      "The tools its steps declare could not be checked: this pod's capabilities could not be read.",
    ];
  }
  if (check.missing.length === 0) return [];
  return [
    `A run of "${input.playbook.name}" on this pod's AI will refuse to start: its ${stepsLacking(check.missing)}, which a run on this pod cannot use. Add a capability that serves them, hand its runs to an agent that has them, or take them off the step.`,
  ];
}

/**
 * Refuse a run on the pod's own AI whose tools lack what a step declares.
 * Call it before any session, room, run row or proposal exists.
 */
export async function refuseRunMissingTools(
  input: {
    playbook: RunToolsPlaybook;
    workspaceId: string | null;
    userId: string;
    /** Who runs it (`resolveRunChoice`): an agent brings its own tools. */
    handedToAgent: boolean;
    executor: string;
  },
  deps?: Pick<RunToolProfileDeps, "readRegistry">
): Promise<void> {
  if (input.handedToAgent || input.executor === "external-agent") return;
  const check = await findRunToolsMissing(input, deps);
  if (check.status !== "ok" || check.missing.length === 0) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: describeRunToolsMissing(input.playbook.name, check.missing),
    cause: { reasonCode: RUN_TOOLS_MISSING, missing: check.missing },
  });
}
