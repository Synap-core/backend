/**
 * Entity Links Router — the status-propagates edges (Phase 1, decision
 * aa0de6e6, synthesis doc 5b71a257).
 *
 * Two doors:
 *   listFor  — every status-propagates link touching an entity (as source or
 *     target), with the far end's identity and the config mapping. The entity
 *     card's chip renders from this.
 *   create   — governed insert of a status-propagates link. An agent's create
 *     files a proposal (checkPermissionOrPropose); a person's writes the row.
 *
 * Deliberately not a full edges CRUD: other link types (blast-radius
 * proposals, live-linked documents) are Phase 2+ territory. Only
 * `link_type = "status-propagates"` is servable today. No delete door: a link
 * is removed through the entity's own links UI, never by hand.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, or } from "drizzle-orm";
import { getDb, entityLinks, entities } from "@synap/database";
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext } from "../../access/access-context.js";
import { scopedDb } from "../../db.js";
import { AccessContext } from "../../access/access-context.js";
import { scopedDb } from "../../db.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

export const entityLinksRouter = router({
  /**
   * The links touching an entity, as source or target — the card's chip data.
   * One select with the far end's title + kind.
   */
  listFor: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        linkType: z.string().max(64).default("status-propagates"),
      })
    )
    .query(async ({ input }) => {
      const database = scopedDb(AccessContext.from(ctx));
      const [entity] = await database
        .select({ id: entities.id, deletedAt: entities.deletedAt })
        .from(entities)
        .where(eq(entities.id, input.entityId))
        .limit(1);
      if (!entity || entity.deletedAt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }
      const rows = await database
        .select()
        .from(entityLinks)
        .where(
          and(
            or(
              eq(entityLinks.sourceEntityId, input.entityId),
              eq(entityLinks.targetEntityId, input.entityId)
            ),
            eq(entityLinks.linkType, input.linkType)
          )
        );
      const farIds = [
        ...new Set(
          rows.map((r) =>
            r.sourceEntityId === input.entityId
              ? r.targetEntityId
              : r.sourceEntityId
          )
        ),
      ];
      const farRows = farIds.length
        ? await database
            .select({
              id: entities.id,
              title: entities.title,
              type: entities.type,
            })
            .from(entities)
            .where(or(...farIds.map((id) => eq(entities.id, id))))
        : [];
      const farById = new Map(farRows.map((r) => [r.id, r]));
      return rows.map((row) => {
        const isSource = row.sourceEntityId === input.entityId;
        const farId = isSource ? row.targetEntityId : row.sourceEntityId;
        const far = farById.get(farId);
        return {
          id: row.id,
          direction: isSource ? ("source" as const) : ("target" as const),
          linkType: row.linkType,
          config: row.config,
          farEntity: far
            ? { id: far.id, title: far.title, type: far.type }
            : null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      });
    }),

  /**
   * Insert a status-propagates link. The link's SOURCE is the entity whose
   * status move will ripple; the TARGET is the entity that moves with it.
   * Self-links and duplicates are refused.
   */
  create: protectedProcedure
    .input(
      z.object({
        sourceEntityId: z.string().uuid(),
        targetEntityId: z.string().uuid(),
        linkType: z.literal("status-propagates").default("status-propagates"),
        config: z
          .object({
            mapping: z.record(z.string(), z.string()).optional(),
          })
          .optional()
          .default({}),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.sourceEntityId === input.targetEntityId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A status link cannot target its own source",
        });
      }
      const database = scopedDb(AccessContext.from(ctx));
      const [source, target] = await Promise.all([
        database
          .select({ id: entities.id, deletedAt: entities.deletedAt })
          .from(entities)
          .where(eq(entities.id, input.sourceEntityId))
          .limit(1),
        database
          .select({ id: entities.id, deletedAt: entities.deletedAt })
          .from(entities)
          .where(eq(entities.id, input.targetEntityId))
          .limit(1),
      ]);
      if (!source[0] || source[0].deletedAt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source entity not found",
        });
      }
      if (!target[0] || target[0].deletedAt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Target entity not found",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "link",
        action: "create",
        data: {
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          linkType: input.linkType,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Status link creation requires approval.",
        };
      }

      try {
        const [row] = await database
          .insert(entityLinks)
          .values({
            sourceEntityId: input.sourceEntityId,
            targetEntityId: input.targetEntityId,
            linkType: input.linkType,
            config: input.config,
          })
          .returning();
        return { status: "granted" as const, link: row };
      } catch (err) {
        // Unique (source, target, link_type) — a duplicate link is a conflict.
        if (
          err instanceof Error &&
          /entity_links_source_target_type_unique/i.test(err.message)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This status link already exists",
          });
        }
        throw err;
      }
    }),
});
