/**
 * Suggest useful views from an import graph (HITL).
 *
 * After a successful materialize, count create_entity ops by profileSlug and
 * file PENDING `view/create` proposals for humans to approve — same
 * createEventBackedProposal path as the rest of the product. Agnostic: no
 * product-domain names (Foundation/CRM/Content OS); heuristics use only slug
 * keywords (task/todo, person/contact, note/article, …).
 *
 * Best-effort: never throws; failures log and return [].
 */

import { randomUUID } from "crypto";
import { ProfileResolutionService, db } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";
import type { OrchestratorContext } from "./types.js";

const logger = createLogger({ module: "import-orchestrator/suggest-views" });

/** Max view proposals filed per import apply. */
export const MAX_VIEW_PROPOSALS_PER_IMPORT = 5;

export type ViewTypeHint = "list" | "table";

export type ProfileSlugCount = {
  profileSlug: string;
  count: number;
  /** Distinct targetWorkspaceId values among ops of this slug (excludes unset). */
  workspaceHomes: string[];
};

/**
 * Count create_entity ops by profileSlug. Pure / side-effect free.
 */
export function countCreateEntityByProfile(
  operations: ReadonlyArray<CompositeProposalOperation>
): ProfileSlugCount[] {
  const bySlug = new Map<string, { count: number; homes: Set<string> }>();
  for (const op of operations) {
    if (op.op !== "create_entity") continue;
    if (typeof op.profileSlug !== "string" || op.profileSlug.length === 0) {
      continue;
    }
    // Skip ops that only link an existing entity (no new materialize).
    if (op.existingEntityId) continue;
    let entry = bySlug.get(op.profileSlug);
    if (!entry) {
      entry = { count: 0, homes: new Set() };
      bySlug.set(op.profileSlug, entry);
    }
    entry.count += 1;
    if (
      typeof op.targetWorkspaceId === "string" &&
      op.targetWorkspaceId.length > 0
    ) {
      entry.homes.add(op.targetWorkspaceId);
    }
  }
  return Array.from(bySlug.entries())
    .map(([profileSlug, { count, homes }]) => ({
      profileSlug,
      count,
      workspaceHomes: Array.from(homes),
    }))
    .sort(
      (a, b) => b.count - a.count || a.profileSlug.localeCompare(b.profileSlug)
    );
}

/**
 * Threshold for suggesting a view for a slug.
 * Task/todo-like profiles: even a single item is useful as a list.
 * Everything else: need at least 2 entities to justify a dedicated view.
 */
export function minCountForSlug(profileSlug: string): number {
  if (/task|todo/i.test(profileSlug)) return 1;
  return 2;
}

/**
 * Heuristic view type + display name from profile slug keywords only.
 * No product-domain hardcoding.
 */
export function chooseViewHint(
  profileSlug: string,
  displayName: string
): { type: ViewTypeHint; name: string } {
  const display = displayName.trim() || profileSlug;

  if (/task|todo|action/i.test(profileSlug)) {
    // Friendly default for task/todo; action-like slugs keep "${display} list".
    const name = /task|todo/i.test(profileSlug) ? "To-dos" : `${display} list`;
    return { type: "list", name };
  }
  if (/person|contact|company|org/i.test(profileSlug)) {
    return { type: "table", name: display };
  }
  if (/note|article|bookmark/i.test(profileSlug)) {
    return { type: "list", name: `${display} list` };
  }
  return { type: "table", name: display };
}

/**
 * Prefer a single shared targetWorkspaceId for all ops of this slug;
 * else fall back to ctx.workspaceId; else null (pod-wide).
 */
export function resolveViewWorkspaceId(
  workspaceHomes: string[],
  ctxWorkspaceId: string | null | undefined
): string | null {
  if (workspaceHomes.length === 1) return workspaceHomes[0]!;
  return ctxWorkspaceId ?? null;
}

/**
 * After a successful import materialize, create PENDING view/create proposals
 * for useful profile-scoped views. Best-effort — never throws.
 *
 * @returns proposal ids that were created (may be empty).
 */
export async function suggestViewsFromImportGraph(
  ctx: OrchestratorContext,
  operations: ReadonlyArray<CompositeProposalOperation>,
  opts?: { agentUserId?: string | null; source?: string }
): Promise<string[]> {
  try {
    const counts = countCreateEntityByProfile(operations).filter(
      (c) => c.count >= minCountForSlug(c.profileSlug)
    );
    if (counts.length === 0) return [];

    const candidates = counts.slice(0, MAX_VIEW_PROPOSALS_PER_IMPORT);
    const resolver = new ProfileResolutionService(db);
    const agentUserId =
      opts?.agentUserId ??
      (typeof ctx.trpcCtx?.agentUserId === "string"
        ? (ctx.trpcCtx.agentUserId as string)
        : null);
    const source = opts?.source ?? "intelligence";
    const proposalIds: string[] = [];

    for (const candidate of candidates) {
      try {
        const workspaceId = resolveViewWorkspaceId(
          candidate.workspaceHomes,
          ctx.workspaceId
        );

        const profile = await resolver.resolveProfile(
          candidate.profileSlug,
          ctx.userId,
          workspaceId
        );
        if (!profile?.id) {
          logger.warn(
            {
              profileSlug: candidate.profileSlug,
              userId: ctx.userId,
              workspaceId,
            },
            "import.suggestViews: profile not found — skipping"
          );
          continue;
        }

        const displayName =
          profile.displayName?.trim() || candidate.profileSlug;
        const hint = chooseViewHint(candidate.profileSlug, displayName);
        const targetId = randomUUID();
        const summary = `Create ${hint.type} view "${hint.name}" for ${candidate.count} imported ${candidate.profileSlug}`;

        const { proposal } = await createEventBackedProposal({
          userId: ctx.userId,
          workspaceId,
          targetType: "view",
          targetId,
          // Executor key is `view/create` = targetType/proposalType (gate uses action "create").
          proposalType: "create",
          action: "create",
          source,
          summary,
          ...(agentUserId ? { agentUserId } : {}),
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          data: {
            // Request-shaped envelope (matches checkPermissionOrPropose / views.create gate)
            // so approve-executors `view/create` reads proposal.data.data.{name,type,scopeProfileIds}.
            requestId: randomUUID(),
            source,
            sourceId: ctx.userId,
            workspaceId,
            targetType: "view",
            targetId,
            changeType: "create",
            data: {
              name: hint.name,
              type: hint.type,
              scopeProfileIds: [profile.id],
            },
            reasoning: `Suggested after import: ${candidate.count} ${candidate.profileSlug} entities materialized.`,
            summary,
          },
        });

        const id = (proposal as { id?: string } | null | undefined)?.id;
        if (id) proposalIds.push(id);
      } catch (err) {
        logger.warn(
          { err, profileSlug: candidate.profileSlug, userId: ctx.userId },
          "import.suggestViews: failed to create view proposal (import preserved)"
        );
      }
    }

    if (proposalIds.length > 0) {
      logger.info(
        {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          count: proposalIds.length,
          proposalIds,
        },
        "import.suggestViews: pending view proposals created"
      );
    }
    return proposalIds;
  } catch (err) {
    logger.warn(
      { err, userId: ctx.userId },
      "import.suggestViews: unexpected failure (import preserved)"
    );
    return [];
  }
}
