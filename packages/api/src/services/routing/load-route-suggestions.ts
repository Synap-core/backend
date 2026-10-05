/**
 * loadRouteSuggestions — the capture follow-up's call into the router
 * (intake plan §3.5): for the entities a capture created or proposed, load the
 * candidates and rank them ONCE with `suggestRoutesForEntities`:
 *   - PLAYBOOKS through `playbooks.matchForEntity` (the canonical playbook
 *     matcher, access-layer scoped);
 *   - RULES through `match-rules-for-entity.ts`: the PROPOSE-MODE rules the
 *     capture's own `entity.create.completed` fires, decided by the trigger
 *     matcher's pure `automationTriggerMatches` (one predicate, shared with the
 *     live loop). Auto rules are not suggested — they already ran.
 * A playbook built for the entity's kind with no standing propose rule yet
 * carries `alwaysProposeOffer`, so a host may offer "Always propose this"
 * (which creates a propose rule through `skills.createRule`, governed).
 *
 * SUGGEST ONLY. Nothing here runs a playbook or triggers an automation; the
 * suggestion carries its `reason` so the surface can show why, and the user
 * confirms through the existing run doors.
 *
 * HONEST STATES, never folded into "no suggestions":
 *   ok      — ranked (an entity may have an empty list: nothing matched)
 *   skipped — the matchers could not be asked (no workspace lens: both need
 *             one — the host EXPLAINS this; or nothing was captured)
 *   failed  — a matcher threw; the error is named
 */

import { createLogger } from "@synap-core/core";
import {
  loadRuleCandidates,
  matchProposeRulesForEntity,
  type ProposeRuleMatches,
} from "./match-rules-for-entity.js";
import {
  suggestRoutesForEntities,
  type EntityRouteSuggestions,
  type RouteCandidate,
} from "./suggest-routes.js";

const logger = createLogger({ module: "routing/load-route-suggestions" });

/** Inline suggestions, not a catalogue: at most this many entities are routed. */
export const ROUTE_SUGGESTION_MAX_ENTITIES = 10;

export type RouteSuggestionsEcho =
  | { status: "ok"; entities: EntityRouteSuggestions[]; truncated?: true }
  | { status: "skipped"; reason: "no_workspace" | "no_entities" }
  | { status: "failed"; error: string };

type PlaybookMatch = {
  id: string;
  name: string;
  goalTemplate: string | null;
  subjectProfileSlug: string | null;
  signals?: ReadonlyArray<{ type: string; profileSlug?: string }>;
};
type MatchArgs = {
  profileSlug: string;
  entityId?: string;
  workspaceId: string;
  intentText?: string;
};

export interface RouteMatchers {
  playbooks: (args: MatchArgs) => Promise<PlaybookMatch[]>;
  /** The propose-mode rules this entity's capture event fires. */
  rules: (args: MatchArgs) => Promise<ProposeRuleMatches>;
}

/** The real matchers, called under the caller's own ctx + workspace lens. */
async function defaultMatchers(
  ctx: Record<string, unknown>,
  workspaceId: string
): Promise<RouteMatchers> {
  // Lazy: the router imports back into services.
  const { playbooksRouter } = await import("../../routers/playbooks.js");
  // `playbooks.matchForEntity` is a workspaceProcedure — the lens rides the ctx.
  const lensCtx = { ...ctx, workspaceId };
  const pb = playbooksRouter.createCaller(
    lensCtx as Parameters<typeof playbooksRouter.createCaller>[0]
  );
  // The rule rows are the same for every entity of one capture: read ONCE.
  let rows: ReturnType<typeof loadRuleCandidates> | undefined;
  return {
    playbooks: (args) => pb.matchForEntity(args),
    rules: async (args) =>
      matchProposeRulesForEntity({
        rows: await (rows ??= loadRuleCandidates(lensCtx, workspaceId)),
        ...(args.entityId ? { entityId: args.entityId } : {}),
        profileSlug: args.profileSlug,
      }),
  };
}

export async function loadRouteSuggestions(input: {
  ctx: Record<string, unknown>;
  workspaceId: string | null | undefined;
  entities: ReadonlyArray<{ entityId?: string; profileSlug: string }>;
  intentText?: string | null;
  /** Injected for tests; defaults to the two matcher doors. */
  matchers?: RouteMatchers;
}): Promise<RouteSuggestionsEcho> {
  if (input.entities.length === 0) {
    return { status: "skipped", reason: "no_entities" };
  }
  if (!input.workspaceId) return { status: "skipped", reason: "no_workspace" };
  const workspaceId = input.workspaceId;
  const intentText = input.intentText?.trim().slice(0, 2000) || undefined;
  const routed = input.entities.slice(0, ROUTE_SUGGESTION_MAX_ENTITIES);

  try {
    const matchers =
      input.matchers ?? (await defaultMatchers(input.ctx, workspaceId));
    const ranked = await Promise.all(
      routed.map(async (e) => {
        const args: MatchArgs = {
          profileSlug: e.profileSlug,
          ...(e.entityId ? { entityId: e.entityId } : {}),
          workspaceId,
          ...(intentText ? { intentText } : {}),
        };
        const [pbs, rules] = await Promise.all([
          matchers.playbooks(args),
          matchers.rules(args),
        ]);
        const candidates: RouteCandidate[] = [
          ...pbs.map((p) => ({
            kind: "playbook" as const,
            id: p.id,
            name: p.name,
            text: [p.goalTemplate],
            subjectProfileSlug: p.subjectProfileSlug,
            // Built for a kind, and no standing propose rule asks for it yet.
            ...(p.subjectProfileSlug && !rules.proposedPlaybookIds.has(p.id)
              ? { alwaysProposeOffer: true as const }
              : {}),
          })),
          ...rules.matches.map((r) => ({
            kind: "automation" as const,
            id: r.id,
            name: r.name,
            text: [r.description],
            // The rule's own kind filter is the evidence; a rule with none
            // fires for anything new (`anyKind`) and needs an intent word.
            subjectProfileSlug: r.filterProfileSlug,
            proposes: true as const,
          })),
        ];
        const facetSlugs = [
          ...new Set(
            pbs.flatMap((p) =>
              (p.signals ?? [])
                .filter((s) => s.type === "facet" && s.profileSlug)
                .map((s) => s.profileSlug as string)
            )
          ),
        ];
        return {
          ...(e.entityId ? { entityId: e.entityId } : {}),
          profileSlug: e.profileSlug,
          ...(facetSlugs.length > 0 ? { facetSlugs } : {}),
          candidates,
        };
      })
    );
    return {
      status: "ok",
      entities: suggestRoutesForEntities({ entities: ranked, intentText }),
      ...(input.entities.length > routed.length
        ? { truncated: true as const }
        : {}),
    };
  } catch (err) {
    logger.warn(
      { err, workspaceId },
      "route suggestions NOT loaded — the capture stands; the response says so"
    );
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
