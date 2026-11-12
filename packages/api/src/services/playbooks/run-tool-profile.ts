/**
 * THE TOOLS A PLAYBOOK RUN MAY CARRY — resolved here, sent to the IS as the
 * turn's FINAL list (plan 08e4fba7, founder decisions 3 and 4, 9 Nov 2026).
 *
 * A run gets the FLOOR of its class plus its playbook's ONE `tools` list,
 * "only these" (`@synap/playbooks` `run-tools.ts`: `runClassOf`, the floors,
 * the run-tool vocabulary). While a stage that declares its own `tools` is
 * active, that list (a subset of the playbook's) replaces the playbook's.
 *
 * Each declared entry is, in this order: a run tool (an IS tool name, sent
 * as is in `tools`); an intent slug (the verbs serving it on this pod); else
 * a capability by name or id, or a verb id (its verbs). Verbs reach the run
 * through `run_capability`, narrowed to them by the IS.
 *
 * Founder rule (2026-11-05): "We never send all the tools. That's the goal of
 * the playbooks itself." Run 9d57a207 sent 50 tools and an 82k-char prompt on
 * every call (pod finding 3fb5dae8).
 *
 * NOTHING ELSE DECLARES A RUN'S TOOLS: not the `grants` links (they stay as
 * governance edges, e.g. a follow's grant widening), not the space's
 * `taskIntents`, not `required_intents` (migration 0419 folded all four into
 * `tools`).
 *
 * ONE RESOLVER for every run turn: the kickoff (`is-agent-executor`), the
 * automatic continuation (`run-turn-end`) and the person's answer that wakes a
 * live run (`session-answer`) all read the same declaration here.
 *
 * ROUTING, NEVER AUTHORIZATION: a tool listed here is only OFFERED. Every run
 * of it still meets the grant gate and `decideAgentPolicy` at the pod.
 *
 * A FAILED READ IS NOT "DECLARES NOTHING": it comes back `capabilitiesRead:
 * "failed"` with the class floor only (the SHORT floor when even the playbook
 * could not be read), so the IS says so to the agent instead of a calm list.
 *
 * NO BOUNDS ARE MIRRORED HERE: the IS cuts an over-long list instead of
 * refusing the turn (IS `run-profile.ts`), so the pod keeps no hand copy of
 * its limits.
 */
import { createLogger } from "@synap-core/core";
import { isKnownIntent } from "@synap-core/types/capability-intents";
import type { RunToolProfile } from "@synap/intelligence-client";
import {
  activeToolsList,
  isRunToolName,
  readToolsList,
  runClassOf,
  runTurnToolNames,
  RUN_TOOL_FLOORS,
  stageToolsOutsidePlaybook,
  type RunClass,
} from "@synap/playbooks";
import type { IntentVerbMatch } from "../capabilities/capability-intent-index.js";
import { activeStageTier } from "./run-stage-tier.js";

const logger = createLogger({ module: "run-tool-profile" });

/** What the registry says about one capability: its kind, id, name, verbs. */
export interface GrantableCapability {
  kind?: string;
  id: string;
  name: string;
  /** `kind` = the registry's read / write / action axis (a trial keeps reads). */
  verbs?: ReadonlyArray<{ id: string; kind?: string }>;
}

export interface RunToolProfileDeps {
  /** The playbook's name, `tools`, executor, stages and own space; null = no such row. */
  readPlaybook(playbookId: string): Promise<{
    name: string;
    tools: unknown;
    executor: string | null;
    stages: unknown;
    workspaceId: string | null;
  } | null>;
  /** The session's active stage key (null = stageless). */
  readCurrentStage(sessionId: string): Promise<string | null>;
  /**
   * The session is a TRIAL run (`metadata.trial`, the rule lab): it is
   * offered read verbs only (throws when it cannot be read).
   */
  readTrial(sessionId: string): Promise<boolean>;
  /** ONE registry read under the run's lens: intent → verbs, and every capability. */
  readRegistry(lens: { workspaceId: string | null; userId: string }): Promise<{
    index: ReadonlyMap<string, readonly IntentVerbMatch[]>;
    capabilities: readonly GrantableCapability[];
  }>;
}

/** The real reads (exported so a test can swap ONE of them). */
export const defaultDeps: RunToolProfileDeps = {
  async readPlaybook(playbookId) {
    const { db, eq, playbooks } = await import("@synap/database");
    const row = await db.query.playbooks.findFirst({
      where: eq(playbooks.id, playbookId),
      columns: {
        name: true,
        tools: true,
        executor: true,
        stages: true,
        workspaceId: true,
      },
    });
    return row ?? null;
  },
  async readCurrentStage(sessionId) {
    const { db, eq, focusSessions } = await import("@synap/database");
    const row = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: { currentStage: true },
    });
    return row?.currentStage ?? null;
  },
  async readTrial(sessionId) {
    const { db, eq, focusSessions } = await import("@synap/database");
    const { trialStampOf } = await import("@synap/capability-gate");
    const row = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: { metadata: true },
    });
    return trialStampOf(row?.metadata) !== null;
  },
  async readRegistry(lens) {
    const { listCapabilities } =
      await import("../capabilities/capability-registry.js");
    const { foldVerbsByIntent } =
      await import("../capabilities/capability-intent-index.js");
    const capabilities = await listCapabilities(lens, { limit: null });
    return { index: foldVerbsByIntent(capabilities), capabilities };
  },
};

/**
 * The verbs of the capabilities a list names. PURE. An entry names a
 * capability by id or by name (every verb of it is offered), or one verb by
 * its id. An entry the run's lens cannot see offers nothing.
 */
export function namedVerbs(
  entries: readonly string[],
  capabilities: readonly GrantableCapability[],
  readsOnly = false
): string[] {
  const verbs: string[] = [];
  const keep = (v: { kind?: string }) => !readsOnly || v.kind === "read";
  for (const entry of entries) {
    for (const cap of capabilities) {
      if (cap.id === entry || cap.name === entry) {
        for (const v of cap.verbs ?? []) if (keep(v)) verbs.push(v.id);
        continue;
      }
      for (const v of cap.verbs ?? []) {
        if (v.id === entry && keep(v)) verbs.push(v.id);
      }
    }
  }
  return verbs;
}

/** The named entries no capability (by id or name) and no verb (by id) matches. PURE. */
function unresolvedNames(
  entries: readonly string[],
  capabilities: readonly GrantableCapability[]
): string[] {
  return entries.filter(
    (entry) =>
      !capabilities.some(
        (cap) =>
          cap.id === entry ||
          cap.name === entry ||
          (cap.verbs ?? []).some((v) => v.id === entry)
      )
  );
}

/** The active stage's entries its playbook's list does not hold. PURE. */
function stageToolsOutside(
  playbookTools: readonly string[],
  stages: unknown,
  currentStage: string | null
): string[] {
  if (!currentStage || !Array.isArray(stages)) return [];
  const stage = stages.find(
    (s) =>
      !!s &&
      typeof s === "object" &&
      (s as { key?: unknown }).key === currentStage
  ) as { tools?: unknown } | undefined;
  return stageToolsOutsidePlaybook(playbookTools, readToolsList(stage?.tools));
}

/**
 * The run's verbs: named verbs first (what the playbook named outright), then
 * the verbs serving each intent in the intents' order; each verb once. PURE.
 */
export function foldRunVerbs(
  named: readonly string[],
  intents: readonly string[],
  index: ReadonlyMap<string, readonly IntentVerbMatch[]>
): string[] {
  const out: string[] = [];
  for (const verbId of [
    ...named,
    ...intents.flatMap((intent) =>
      (index.get(intent) ?? []).map((m) => m.verbId)
    ),
  ]) {
    if (!out.includes(verbId)) out.push(verbId);
  }
  return out;
}

/** The intent index keeping only read verbs (a trial run). PURE. */
function readVerbsOnly(
  index: ReadonlyMap<string, readonly IntentVerbMatch[]>
): ReadonlyMap<string, readonly IntentVerbMatch[]> {
  return new Map(
    [...index].map(([intent, matches]) => [
      intent,
      matches.filter((m) => m.verbKind === "read"),
    ])
  );
}

/**
 * The run profile of one turn of a playbook run: the class floor plus the
 * declared run tools (`tools`), and the verbs the declared intents and
 * capabilities resolve to under the run's lens (`verbs`).
 */
export async function resolveRunToolProfile(
  input: {
    playbookId: string;
    /** The run's workspace (its lens for the registry read). */
    workspaceId: string | null;
    userId: string;
    /** The run's session: its active stage's `tools` narrow the playbook's. */
    sessionId?: string | null;
  },
  deps: RunToolProfileDeps = defaultDeps
): Promise<RunToolProfile> {
  let playbookName: string | undefined;
  let runClass: RunClass | undefined;
  let intents: string[] = [];
  try {
    const playbook = await deps.readPlaybook(input.playbookId);
    if (!playbook) {
      throw new Error(`no playbook ${input.playbookId}`);
    }
    playbookName = playbook.name;
    runClass = runClassOf(playbook);
    const [currentStage, trial] = await Promise.all([
      input.sessionId ? deps.readCurrentStage(input.sessionId) : null,
      // A TRIAL (the rule lab) is offered read verbs only: its writes are
      // refused at the gate anyway, so offering them would only spend turns.
      input.sessionId ? deps.readTrial(input.sessionId) : false,
    ]);
    const playbookTools = readToolsList(playbook.tools);
    const declared = activeToolsList(
      playbookTools,
      playbook.stages,
      currentStage
    );
    // A stored stage entry outside the playbook's list is never offered (a
    // row written before the door checked it): say so, once per entry.
    for (const entry of stageToolsOutside(
      playbookTools,
      playbook.stages,
      currentStage
    )) {
      logger.warn(
        { playbookId: input.playbookId, stage: currentStage, entry },
        "run-tool-profile: a stage lists a tool its playbook does not — not offered"
      );
    }
    // A one-shot run has no tools at all: nothing it declares is offered.
    const tools =
      runClass === "one-shot" ? [] : runTurnToolNames(runClass, declared);
    const rest = declared.filter((t) => !isRunToolName(t));
    intents = rest.filter((t) => isKnownIntent(t));
    const named = rest.filter((t) => !isKnownIntent(t));
    let verbs: string[] = [];
    if (runClass !== "one-shot" && rest.length > 0) {
      const registry = await deps.readRegistry({
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      const index = trial ? readVerbsOnly(registry.index) : registry.index;
      verbs = foldRunVerbs(
        namedVerbs(named, registry.capabilities, trial),
        intents,
        index
      );
      // An entry nothing on this pod serves offers nothing: a fact (a later
      // install may serve it), never a refusal; said once per entry.
      for (const entry of [
        ...unresolvedNames(named, registry.capabilities),
        ...intents.filter((i) => (index.get(i) ?? []).length === 0),
      ]) {
        logger.warn(
          { playbookId: input.playbookId, entry },
          "run-tool-profile: a declared tool resolves to nothing on this pod — not offered"
        );
      }
    }
    const tier = activeStageTier(playbook.stages, currentStage);
    return {
      playbookId: input.playbookId,
      ...(playbookName ? { playbookName } : {}),
      runClass,
      tools,
      intents,
      verbs,
      capabilitiesRead: "ok",
      ...(tier ? { tier } : {}),
    };
  } catch (err) {
    logger.error(
      { err, playbookId: input.playbookId, workspaceId: input.workspaceId },
      "run-tool-profile: the run's declared tools could not be read — the run gets its class floor only and is told so"
    );
    return {
      playbookId: input.playbookId,
      ...(playbookName ? { playbookName } : {}),
      ...(runClass ? { runClass } : {}),
      tools: [...RUN_TOOL_FLOORS[runClass ?? "short"]],
      intents,
      verbs: [],
      capabilitiesRead: "failed",
    };
  }
}
