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
 *
 * Dedup contract (dogfood 2026-07-28):
 * - Never file views when materialize created 0 entities (idempotent re-apply).
 * - Never file a second PENDING view with the same name + profile in the same
 *   workspace — return the existing proposal id instead.
 */

import { createHash, randomUUID } from "crypto";
import {
  ProfileResolutionService,
  db,
  proposals,
  ProposalStatus,
  eq,
  and,
  isNull,
} from "@synap/database";
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
 * Stable targetId for a suggested import view so agent-side dedup (when
 * agentUserId is present) can also collide on targetId+payload.
 * Deterministic UUID-shaped hex from name + profile + workspace home.
 */
export function stableViewTargetId(parts: {
  workspaceId: string | null;
  profileId: string;
  viewName: string;
}): string {
  const h = createHash("sha256")
    .update(
      `import-view\0${parts.workspaceId ?? "pod"}\0${parts.profileId}\0${parts.viewName}`
    )
    .digest("hex");
  // Format as UUID v4-ish (version nibble fixed to 4, variant 8).
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * Find an existing PENDING view/create suggestion with the same display name
 * + profile scope in this workspace (or pod-wide when workspaceId is null).
 * Works for human-authored rows too (agent dedup_hash does not cover them).
 */
export async function findExistingPendingViewSuggestion(opts: {
  workspaceId: string | null;
  viewName: string;
  profileId: string;
  userId: string;
}): Promise<string | null> {
  try {
    const workspaceClause =
      opts.workspaceId == null
        ? isNull(proposals.workspaceId)
        : eq(proposals.workspaceId, opts.workspaceId);

    const rows = await db
      .select({ id: proposals.id, data: proposals.data })
      .from(proposals)
      .where(
        and(
          eq(proposals.status, ProposalStatus.PENDING),
          eq(proposals.proposalType, "create"),
          eq(proposals.targetType, "view"),
          eq(proposals.createdBy, opts.userId),
          workspaceClause
        )
      )
      .limit(40);

    for (const row of rows) {
      const data = row.data as {
        data?: {
          name?: string;
          scopeProfileIds?: string[];
        };
        summary?: string;
      } | null;
      const inner = data?.data;
      const name = inner?.name;
      const scopes = inner?.scopeProfileIds ?? [];
      if (name === opts.viewName && scopes.includes(opts.profileId)) {
        return row.id;
      }
      // Fallback: summary form used by suggestViews
      if (
        typeof data?.summary === "string" &&
        data.summary.includes(`"${opts.viewName}"`)
      ) {
        return row.id;
      }
    }
    return null;
  } catch (err) {
    logger.warn(
      { err, viewName: opts.viewName },
      "import.suggestViews: pending-view lookup failed"
    );
    return null;
  }
}

/**
 * After a successful import materialize, create PENDING view/create proposals
 * for useful profile-scoped views. Best-effort — never throws.
 *
 * @returns proposal ids that were created or reused (may be empty).
 */
export async function suggestViewsFromImportGraph(
  ctx: OrchestratorContext,
  operations: ReadonlyArray<CompositeProposalOperation>,
  opts?: {
    agentUserId?: string | null;
    source?: string;
    /**
     * Entities newly created by this apply. When 0, skip filing views —
     * idempotent re-apply / empty materialize must not spam the inbox.
     */
    createdCount?: number;
  }
): Promise<string[]> {
  try {
    if (opts?.createdCount !== undefined && opts.createdCount <= 0) {
      logger.info(
        { userId: ctx.userId, createdCount: opts.createdCount },
        "import.suggestViews: skipped (no new entities materialized)"
      );
      return [];
    }

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

        // Human + agent: collapse inbox spam when same view already pending.
        const existingId = await findExistingPendingViewSuggestion({
          workspaceId,
          viewName: hint.name,
          profileId: profile.id,
          userId: ctx.userId,
        });
        if (existingId) {
          proposalIds.push(existingId);
          logger.info(
            {
              proposalId: existingId,
              viewName: hint.name,
              profileSlug: candidate.profileSlug,
            },
            "import.suggestViews: reusing pending view proposal"
          );
          continue;
        }

        const targetId = stableViewTargetId({
          workspaceId,
          profileId: profile.id,
          viewName: hint.name,
        });
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
            // so approve-executors `view/create` reads proposal.data.data.{name,type,scopeProfileIds,config}.
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
