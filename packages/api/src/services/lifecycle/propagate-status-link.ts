/**
 * Status-link propagation — Phase 0 of the dynamic status links plan
 * (decision aa0de6e6, synthesis doc 5b71a257).
 *
 * When an entity's lifecycle status moves, every `entity_links` row with
 * `link_type = "status-propagates"` and `source_entity_id = <that entity>`
 * asks the target entity to move too. The target move is written through the
 * governed `moveStatus` door — never a raw status write — so a target the
 * actor may not touch is refused, not bypassed.
 *
 * ONE hop, no cascade: Phase 0 propagates from the moved entity to its direct
 * link targets only (targets' own links are not followed). A propagation is a
 * side effect: failures are logged and reported, never thrown into the move
 * that triggered them.
 */
import { and, eq } from "drizzle-orm";
import { db, entityLinks, entities } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { StatusMoveActor } from "./move-status.js";
import { setPropagationActive } from "./propagation-guard.js";

const logger = createLogger({ module: "propagate-status-link" });

export interface PropagateContext {
  actor: StatusMoveActor;
  sessionId?: string | null;
  workspaceId?: string | null;
  reason?: string | null;
}

export interface PropagateStatusLinkResult {
  propagated: Array<{ targetEntityId: string; sourceStatus: string; targetStatus: string }>;
  skipped: Array<{ targetEntityId: string; reason: string }>;
}

/**
 * The target status a link row asks for: the `mapping` in the link's config
 * (source status → target status) if present, else the same status copied
 * across.
 */
function targetStatusFor(config: unknown, sourceStatus: string): string {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const mapping = (config as Record<string, unknown>).mapping;
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      const mapped = (mapping as Record<string, unknown>)[sourceStatus];
      if (typeof mapped === "string" && mapped.length > 0) return mapped;
    }
  }
  return sourceStatus;
}

export async function propagateStatusLink(
  sourceEntityId: string,
  newStatus: string,
  context: PropagateContext
): Promise<PropagateStatusLinkResult> {
  // Guard: the moveStatus call below would re-enter this module. Phase 0 is
  // one hop — a propagation does not trigger further propagations.
  setPropagationActive(true);
  const result: PropagateStatusLinkResult = { propagated: [], skipped: [] };
  try {
    const links = await db
      .select()
      .from(entityLinks)
      .where(
        and(
          eq(entityLinks.sourceEntityId, sourceEntityId),
          eq(entityLinks.linkType, "status-propagates")
        )
      );
    if (links.length === 0) return result;

    // Lazy import: this module is imported by the same door it calls back into.
    const { moveStatus } = await import("./move-status.js");

    for (const link of links) {
      const targetStatus = targetStatusFor(link.config, newStatus);
      try {
        if (link.targetEntityId === sourceEntityId) {
          result.skipped.push({
            targetEntityId: link.targetEntityId,
            reason: "target is the source — self-link ignored",
          });
          continue;
        }
        const [row] = await db
          .select({ id: entities.id, deletedAt: entities.deletedAt })
          .from(entities)
          .where(eq(entities.id, link.targetEntityId))
          .limit(1);
        if (!row || row.deletedAt) {
          result.skipped.push({
            targetEntityId: link.targetEntityId,
            reason: "target entity not found or deleted",
          });
          continue;
        }
        const moved = await moveStatus({
          entityId: link.targetEntityId,
          to: targetStatus,
          actor: context.actor,
          sessionId: context.sessionId ?? null,
          workspaceId: context.workspaceId ?? null,
          reason:
            context.reason ?? `Status "${newStatus}" propagated from ${sourceEntityId}`,
        });
        if (moved.status === "moved" || moved.status === "unchanged") {
          result.propagated.push({
            targetEntityId: link.targetEntityId,
            sourceStatus: newStatus,
            targetStatus,
          });
        } else {
          result.skipped.push({
            targetEntityId: link.targetEntityId,
            reason:
              "reason" in moved
                ? moved.reason
                : moved.status === "conflict"
                  ? `conflict: actual ${moved.actual ?? "none"}`
                  : moved.status,
          });
        }
      } catch (err) {
        logger.warn(
          { err, sourceEntityId, targetEntityId: link.targetEntityId },
          "status-link propagation failed"
        );
        result.skipped.push({
          targetEntityId: link.targetEntityId,
          reason: err instanceof Error ? err.message : "propagation error",
        });
      }
    }
    return result;
  } finally {
    setPropagationActive(false);
  }
}
