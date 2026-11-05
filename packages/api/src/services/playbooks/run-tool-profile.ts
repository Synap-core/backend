/**
 * THE TOOLS A PLAYBOOK RUN MAY CARRY — resolved here, applied by the IS.
 *
 * Founder rule (2026-11-05): "We never send all the tools. That's the goal of
 * the playbooks itself. We send the main tools needed for all runs — the tools
 * of the pod — and only the capabilities listed on the playbook, or listed
 * globally on the template that creates the playbook."
 *
 * Run 9d57a207 (Package ideas) sent 50 tools and an 82k-char system prompt on
 * every call (pod finding 3fb5dae8): the IS got no word that the turn was a
 * run, so it sent the universal agent's whole catalogue.
 *
 * WHERE "LISTED" ALREADY LIVES — no new field:
 *  - on the playbook: `playbooks.required_intents` (migration 0291), slugs of
 *    the `capability_intents` vocabulary;
 *  - globally on the template: its `taskIntents`, installed as the space's
 *    `settings.taskIntents` (`readWorkspaceTaskIntents`).
 * Both are ABSTRACT intents; `intentIndex` folds them into the concrete verb
 * ids the run's lens can see (a verb id is a skill name: `skill_<verbId>` or a
 * `run_capability` verb in the IS).
 *
 * ROUTING, NEVER AUTHORIZATION: a verb listed here is only OFFERED. Every run
 * of it still meets the grant gate and `decideAgentPolicy` at the pod.
 *
 * A FAILED READ IS NOT "DECLARES NOTHING": it comes back `capabilitiesRead:
 * "failed"` so the IS can say so to the agent, instead of a calm empty list.
 */
import { createLogger } from "@synap-core/core";
import type { RunToolProfile } from "@synap/intelligence-client";
import type { IntentVerbMatch } from "../capabilities/capability-intent-index.js";

const logger = createLogger({ module: "run-tool-profile" });

/** The IS accepts at most this many verbs on one run (its `RunProfileSchema`). */
export const RUN_PROFILE_MAX_VERBS = 100;

export interface RunToolProfileDeps {
  /** The playbook's name, declared intents and own space; null = no such row. */
  readPlaybook(playbookId: string): Promise<{
    name: string;
    requiredIntents: unknown;
    workspaceId: string | null;
  } | null>;
  /** The space's declared `taskIntents` (throws when it cannot be read). */
  readTaskIntents(workspaceId: string): Promise<string[]>;
  /** intent → verbs, under the run's lens. */
  readIntentIndex(lens: {
    workspaceId: string | null;
    userId: string;
  }): Promise<Map<string, IntentVerbMatch[]>>;
}

const defaultDeps: RunToolProfileDeps = {
  async readPlaybook(playbookId) {
    const { db, eq, playbooks } = await import("@synap/database");
    const row = await db.query.playbooks.findFirst({
      where: eq(playbooks.id, playbookId),
      columns: { name: true, requiredIntents: true, workspaceId: true },
    });
    return row ?? null;
  },
  async readTaskIntents(workspaceId) {
    const { readWorkspaceTaskIntents } =
      await import("../capabilities/capability-intent-index.js");
    return readWorkspaceTaskIntents({ workspaceId });
  },
  async readIntentIndex(lens) {
    const { intentIndex } =
      await import("../capabilities/capability-intent-index.js");
    return intentIndex(lens);
  },
};

/** The declared intents of a playbook row: strings only, deduplicated. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
}

/**
 * Fold declared intents into the verb ids that serve them. PURE: the order is
 * the intents' order, then the index's; each verb once; capped.
 */
export function foldRunVerbs(
  intents: readonly string[],
  index: ReadonlyMap<string, readonly IntentVerbMatch[]>
): string[] {
  const verbs: string[] = [];
  const seen = new Set<string>();
  for (const intent of intents) {
    for (const match of index.get(intent) ?? []) {
      if (seen.has(match.verbId)) continue;
      seen.add(match.verbId);
      verbs.push(match.verbId);
    }
  }
  return verbs.slice(0, RUN_PROFILE_MAX_VERBS);
}

/**
 * The run profile of a playbook run: the intents its playbook and its space
 * declare, and the verbs that serve them under the run's lens.
 *
 * The space whose `taskIntents` count is the PLAYBOOK's own space (where its
 * template installed it), else the run's.
 */
export async function resolveRunToolProfile(
  input: {
    playbookId: string;
    /** The run's workspace (its lens for the registry read). */
    workspaceId: string | null;
    userId: string;
  },
  deps: RunToolProfileDeps = defaultDeps
): Promise<RunToolProfile> {
  let playbookName: string | undefined;
  let intents: string[] = [];
  try {
    const playbook = await deps.readPlaybook(input.playbookId);
    if (!playbook) {
      throw new Error(`no playbook ${input.playbookId}`);
    }
    playbookName = playbook.name;
    const spaceId = playbook.workspaceId ?? input.workspaceId;
    const taskIntents = spaceId ? await deps.readTaskIntents(spaceId) : [];
    intents = [
      ...new Set([...stringList(playbook.requiredIntents), ...taskIntents]),
    ];
    const verbs =
      intents.length === 0
        ? []
        : foldRunVerbs(
            intents,
            await deps.readIntentIndex({
              workspaceId: input.workspaceId,
              userId: input.userId,
            })
          );
    return {
      playbookId: input.playbookId,
      ...(playbookName ? { playbookName } : {}),
      intents,
      verbs,
      capabilitiesRead: "ok",
    };
  } catch (err) {
    logger.error(
      { err, playbookId: input.playbookId, workspaceId: input.workspaceId },
      "run-tool-profile: the run's declared capabilities could not be read — the run gets the core tools only and is told so"
    );
    return {
      playbookId: input.playbookId,
      ...(playbookName ? { playbookName } : {}),
      intents,
      verbs: [],
      capabilitiesRead: "failed",
    };
  }
}
