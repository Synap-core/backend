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
 *  - on the playbook: its `grants` (`playbook --grants--> tool|skill|command`
 *    links, the runner's `RunContext.capabilities`) and the ACTIVE stage's
 *    `grants` (`PlaybookStage.grants`). Concrete capabilities: each one's verbs
 *    are offered. Official playbooks declare their tools only this way
 *    (meetings-knowledge, research-decision, research-base);
 *  - on the playbook: `playbooks.required_intents` (migration 0291), slugs of
 *    the `capability_intents` vocabulary;
 *  - globally on the template: its `taskIntents`, installed as the space's
 *    `settings.taskIntents` (`readWorkspaceTaskIntents`).
 * Intents are ABSTRACT; `foldVerbsByIntent` folds them into the concrete verb
 * ids the run's lens can see (a verb id is a skill name: `skill_<verbId>` or a
 * `run_capability` verb in the IS). Granted verbs come first: they are what
 * the playbook named outright.
 *
 * ONE RESOLVER for every run turn: the kickoff (`is-agent-executor`), the
 * automatic continuation (`run-turn-end`) and the person's answer that wakes a
 * live run (`session-answer`) all read the same declaration here.
 *
 * ROUTING, NEVER AUTHORIZATION: a verb listed here is only OFFERED. Every run
 * of it still meets the grant gate and `decideAgentPolicy` at the pod.
 *
 * A FAILED READ IS NOT "DECLARES NOTHING": it comes back `capabilitiesRead:
 * "failed"` so the IS can say so to the agent, instead of a calm empty list.
 */
import { createLogger } from "@synap-core/core";
import type { RunToolProfile } from "@synap/intelligence-client";
import { readRequiredIntents, type CapabilityRef } from "@synap/playbooks";
import type { IntentVerbMatch } from "../capabilities/capability-intent-index.js";

const logger = createLogger({ module: "run-tool-profile" });

/**
 * The bounds of the IS's `RunProfileSchema` (IS `agents/base/run-profile.ts`).
 * A profile past one of them would 400 the WHOLE turn, so the pod never sends
 * one: lists are capped, an over-long item is dropped (a cut slug names
 * nothing), the name is cut.
 * They mirror the IS by hand, with no tripwire: the two repos cannot import each other.
 */
export const RUN_PROFILE_MAX_VERBS = 100;
export const RUN_PROFILE_MAX_INTENTS = 50;
const RUN_PROFILE_MAX_INTENT_CHARS = 100;
const RUN_PROFILE_MAX_VERB_CHARS = 200;
const RUN_PROFILE_MAX_NAME_CHARS = 300;

/** What the registry says about one granted capability: its kind, id, name, verbs. */
export interface GrantableCapability {
  kind?: string;
  id: string;
  name: string;
  verbs?: ReadonlyArray<{ id: string }>;
}

/**
 * The registry kinds a grant of each kind names. A `tools` row is listed as
 * `tool`, `builtin-tool` or `source-provider` (`toolKindToCapabilityKind`).
 */
const REGISTRY_KINDS_OF_GRANT: Record<
  CapabilityRef["kind"],
  readonly string[]
> = {
  tool: ["tool", "builtin-tool", "source-provider"],
  skill: ["skill"],
  command: ["command"],
};

/** A grant names this capability: same id or name, and, when both say, same kind. */
function grantNames(grant: CapabilityRef, cap: GrantableCapability): boolean {
  if (cap.id !== grant.id && cap.name !== grant.id) return false;
  const kinds = grant.kind ? REGISTRY_KINDS_OF_GRANT[grant.kind] : undefined;
  return !kinds || !cap.kind || kinds.includes(cap.kind);
}

export interface RunToolProfileDeps {
  /** The playbook's name, declared intents, stages and own space; null = no such row. */
  readPlaybook(playbookId: string): Promise<{
    name: string;
    requiredIntents: unknown;
    stages: unknown;
    workspaceId: string | null;
  } | null>;
  /** The playbook's `grants` links, as the runner resolves them. */
  readGrants(input: {
    playbookId: string;
    userId: string;
  }): Promise<CapabilityRef[]>;
  /** The session's active stage key (null = stageless). */
  readCurrentStage(sessionId: string): Promise<string | null>;
  /** The space's declared `taskIntents` (throws when it cannot be read). */
  readTaskIntents(workspaceId: string): Promise<string[]>;
  /** ONE registry read under the run's lens: intent → verbs, and every capability. */
  readRegistry(lens: { workspaceId: string | null; userId: string }): Promise<{
    index: ReadonlyMap<string, readonly IntentVerbMatch[]>;
    capabilities: readonly GrantableCapability[];
  }>;
}

const defaultDeps: RunToolProfileDeps = {
  async readPlaybook(playbookId) {
    const { db, eq, playbooks } = await import("@synap/database");
    const row = await db.query.playbooks.findFirst({
      where: eq(playbooks.id, playbookId),
      columns: {
        name: true,
        requiredIntents: true,
        stages: true,
        workspaceId: true,
      },
    });
    return row ?? null;
  },
  async readGrants({ playbookId, userId }) {
    // The runner's own read (`run-playbook.ts` step 5), so a run turn offers
    // exactly what `RunContext.capabilities` granted.
    const { getLinksFor, resolveGrantedCapabilities } =
      await import("../links/links-service.js");
    const links = await getLinksFor(userId, "playbook", playbookId);
    return resolveGrantedCapabilities(links, {
      linkType: "grants",
      fromType: "playbook",
    });
  },
  async readCurrentStage(sessionId) {
    const { db, eq, focusSessions } = await import("@synap/database");
    const row = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: { currentStage: true },
    });
    return row?.currentStage ?? null;
  },
  async readTaskIntents(workspaceId) {
    const { readWorkspaceTaskIntents } =
      await import("../capabilities/capability-intent-index.js");
    return readWorkspaceTaskIntents({ workspaceId });
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
 * The active stage's `grants`, read tolerantly off the playbook's stages bag
 * (a stage whose grants are not a list grants nothing).
 */
function activeStageGrants(
  stages: unknown,
  currentStage: string | null
): CapabilityRef[] {
  if (!currentStage || !Array.isArray(stages)) return [];
  const stage = stages.find(
    (s): s is { key: string; grants?: unknown } =>
      !!s &&
      typeof s === "object" &&
      (s as { key?: unknown }).key === currentStage
  );
  if (!stage || !Array.isArray(stage.grants)) return [];
  return stage.grants.filter(
    (g): g is CapabilityRef =>
      !!g &&
      typeof g === "object" &&
      typeof (g as { id?: unknown }).id === "string" &&
      (g as { id: string }).id !== ""
  );
}

/**
 * The verbs of granted capabilities. PURE. A grant names its capability by
 * row id (a `grants` link) or by name (a stage grant may carry either), and by
 * its kind (a skill and a tool may share a name); every verb of a matched
 * capability is offered. A grant the run's lens cannot see offers nothing.
 */
function grantedVerbs(
  grants: readonly CapabilityRef[],
  capabilities: readonly GrantableCapability[]
): string[] {
  const verbs: string[] = [];
  for (const grant of grants) {
    for (const cap of capabilities) {
      if (!grantNames(grant, cap)) continue;
      for (const v of cap.verbs ?? []) verbs.push(v.id);
    }
  }
  return verbs;
}

/**
 * The run's verbs, bounded to what the IS accepts. PURE: granted verbs first,
 * then the verbs serving each intent in the intents' order; each verb once;
 * an over-long id dropped; capped. `dropped` counts the verbs the cap left out.
 */
export function foldRunVerbs(
  granted: readonly string[],
  intents: readonly string[],
  index: ReadonlyMap<string, readonly IntentVerbMatch[]>
): { verbs: string[]; dropped: number } {
  const candidates = [
    ...granted,
    ...intents.flatMap((intent) =>
      (index.get(intent) ?? []).map((m) => m.verbId)
    ),
  ];
  const verbs: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const verbId of candidates) {
    if (seen.has(verbId) || verbId.length > RUN_PROFILE_MAX_VERB_CHARS)
      continue;
    seen.add(verbId);
    if (verbs.length < RUN_PROFILE_MAX_VERBS) verbs.push(verbId);
    else dropped++;
  }
  return { verbs, dropped };
}

/** The declared intents, deduplicated and bounded to what the IS accepts. */
function boundIntents(intents: readonly string[]): string[] {
  return [...new Set(intents)]
    .filter((i) => i.trim() !== "" && i.length <= RUN_PROFILE_MAX_INTENT_CHARS)
    .slice(0, RUN_PROFILE_MAX_INTENTS);
}

/**
 * The run profile of a playbook run: the capabilities its playbook and active
 * stage grant, and the verbs serving the intents its playbook and its space
 * declare, under the run's lens.
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
    /** The run's session: its active stage's grants count. */
    sessionId?: string | null;
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
    playbookName = playbook.name.slice(0, RUN_PROFILE_MAX_NAME_CHARS);
    const spaceId = playbook.workspaceId ?? input.workspaceId;
    const [taskIntents, grants, currentStage] = await Promise.all([
      spaceId ? deps.readTaskIntents(spaceId) : [],
      deps.readGrants({ playbookId: input.playbookId, userId: input.userId }),
      input.sessionId ? deps.readCurrentStage(input.sessionId) : null,
    ]);
    intents = boundIntents([...readRequiredIntents(playbook), ...taskIntents]);
    const allGrants = [
      ...grants,
      ...activeStageGrants(playbook.stages, currentStage),
    ];
    let verbs: string[] = [];
    if (intents.length > 0 || allGrants.length > 0) {
      const registry = await deps.readRegistry({
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      const folded = foldRunVerbs(
        grantedVerbs(allGrants, registry.capabilities),
        intents,
        registry.index
      );
      verbs = folded.verbs;
      if (folded.dropped > 0) {
        logger.warn(
          {
            playbookId: input.playbookId,
            dropped: folded.dropped,
            cap: RUN_PROFILE_MAX_VERBS,
          },
          "run-tool-profile: the run declares more verbs than the IS accepts — granted verbs come first, the rest (intent verbs first) are not offered"
        );
      }
    }
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
