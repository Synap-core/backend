/**
 * loadRouteSuggestions — the capture follow-up's call into the router
 * (intake plan §3.5): for the entities a capture created or proposed, load the
 * playbook AND automation candidates through the two canonical matcher doors
 * (`playbooks.matchForEntity`, `automations.matchForEntity` — access-layer
 * scoped) and rank them ONCE with `suggestRoutesForEntities`.
 *
 * SUGGEST ONLY. Nothing here runs a playbook or triggers an automation; the
 * suggestion carries its `reason` so the surface can show why, and the user
 * confirms through the existing run doors.
 *
 * HONEST STATES, never folded into "no suggestions":
 *   ok      — ranked (an entity may have an empty list: nothing matched)
 *   skipped — the matchers could not be asked (no workspace lens: both doors
 *             require one; or nothing was captured)
 *   failed  — a matcher threw; the error is named
 */

import { createLogger } from "@synap-core/core";
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
type AutomationMatch = {
  id: string;
  name: string;
  description?: string;
  signals: ReadonlyArray<{ type: string }>;
};
type MatchArgs = {
  profileSlug: string;
  entityId?: string;
  workspaceId: string;
  intentText?: string;
};

export interface RouteMatchers {
  playbooks: (args: MatchArgs) => Promise<PlaybookMatch[]>;
  automations: (args: MatchArgs) => Promise<AutomationMatch[]>;
}

/** The real matcher doors, called under the caller's own ctx + workspace lens. */
async function defaultMatchers(
  ctx: Record<string, unknown>,
  workspaceId: string
): Promise<RouteMatchers> {
  // Lazy: both routers import back into services.
  const [{ playbooksRouter }, { automationsRouter }] = await Promise.all([
    import("../../routers/playbooks.js"),
    import("../../routers/automations.js"),
  ]);
  // `playbooks.matchForEntity` is a workspaceProcedure — the lens rides the ctx.
  const lensCtx = { ...ctx, workspaceId };
  const pb = playbooksRouter.createCaller(
    lensCtx as Parameters<typeof playbooksRouter.createCaller>[0]
  );
  const au = automationsRouter.createCaller(
    lensCtx as Parameters<typeof automationsRouter.createCaller>[0]
  );
  return {
    playbooks: (args) => pb.matchForEntity(args),
    automations: (args) => au.matchForEntity(args),
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
        const [pbs, autos] = await Promise.all([
          matchers.playbooks(args),
          matchers.automations(args),
        ]);
        const candidates: RouteCandidate[] = [
          ...pbs.map((p) => ({
            kind: "playbook" as const,
            id: p.id,
            name: p.name,
            text: [p.goalTemplate],
            subjectProfileSlug: p.subjectProfileSlug,
          })),
          ...autos.map((a) => ({
            kind: "automation" as const,
            id: a.id,
            name: a.name,
            text: [a.description],
            subjectProfileSlug: a.signals.some((s) => s.type === "anyKind")
              ? null
              : e.profileSlug,
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
