/**
 * Entities Router — pod-admin (Wave 3 router-decomposition).
 *
 * `adminList`, `adminGet`, `adminDelete`, `adminBatchDelete`,
 * `adminListProfiles` — hard-delete + inspection doors, pod-admin only.
 */

import { z } from "zod";
import { podAdminProcedure } from "../../trpc.js";
import {
  db,
  eq,
  and,
  or,
  isNull,
  inArray,
  desc,
  getDb,
  eventRepository,
  EntityBodyService,
  drizzleSql,
} from "@synap/database";
import { entities, workspaces } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";

export const adminProcs = {
  adminList: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.union([z.string().uuid(), z.null()]).optional(),
        profileSlug: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      if (input.search && input.search.trim().length > 0) {
        const term = `%${input.search.trim()}%`;
        conditions.push(
          or(
            drizzleSql`${entities.title} ILIKE ${term}`,
            drizzleSql`${entities.preview} ILIKE ${term}`,
            drizzleSql`${entities.properties}::text ILIKE ${term}`
          )
        );
      }

      const totalRow = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(entities)
        .where(and(...conditions));
      const total = totalRow[0]?.count ?? 0;

      const rows = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.updatedAt)],
        limit: input.limit,
        offset: input.offset,
        columns: {
          id: true,
          title: true,
          preview: true,
          type: true,
          workspaceId: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
          properties: true,
        },
      });

      // Resolve workspace names for the rows
      const wsIds = Array.from(
        new Set(
          rows.map((r) => r.workspaceId).filter((id): id is string => !!id)
        )
      );
      const wsRows =
        wsIds.length > 0
          ? await db.query.workspaces.findMany({
              where: inArray(workspaces.id, wsIds),
              columns: { id: true, name: true },
            })
          : [];
      const wsNameById = new Map(wsRows.map((w) => [w.id, w.name]));

      // Truncate properties to keep payload small
      const items = rows.map((r) => {
        const propsString = JSON.stringify(r.properties ?? {});
        const truncated =
          propsString.length > 240
            ? propsString.slice(0, 240) + "…"
            : propsString;
        return {
          id: r.id,
          title: r.title,
          preview: r.preview,
          profileSlug: r.type,
          workspaceId: r.workspaceId,
          workspaceName: r.workspaceId
            ? (wsNameById.get(r.workspaceId) ?? null)
            : null,
          userId: r.userId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          propertiesPreview: truncated,
        };
      });

      return { items, total };
    }),
  adminGet: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const row = await db.query.entities.findFirst({
        where: eq(entities.id, input.id),
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const ws = row.workspaceId
        ? await db.query.workspaces.findFirst({
            where: eq(workspaces.id, row.workspaceId),
            columns: { id: true, name: true },
          })
        : null;

      return {
        ...row,
        properties: row.properties ?? {},
        systemData: row.systemData ?? {},
        workspaceName: ws?.name ?? null,
      };
    }),

  /**
   * Admin: hard-delete a single entity by id (no userId filter).
   */
  adminDelete: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      const [deleted] = await database
        .delete(entities)
        .where(eq(entities.id, input.id))
        .returning({
          id: entities.id,
          type: entities.type,
          documentId: entities.documentId,
        });
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }
      // B1: a HARD delete reclaims the linked document row + ALL its storage
      // objects (the current-content object + every version snapshot).
      // Previously orphaned — adminDelete cleaned up neither. Unconditional
      // reverse-cascade via the one body door. The entity row is already gone,
      // so we pass the captured `documentId` directly.
      if (deleted.documentId) {
        await new EntityBodyService(database, eventRepository).deleteBody({
          documentId: deleted.documentId,
        });
      }
      console.log(
        `[pod-admin] adminDelete: entity ${deleted.id} (type=${deleted.type}) permanently deleted`
      );
      return { deleted: true, id: deleted.id, type: deleted.type };
    }),

  /**
   * Admin: hard-delete multiple entities by id list or by profileSlug/workspaceId filter.
   * Requires at least one of: ids or profileSlug.
   */
  adminBatchDelete: podAdminProcedure
    .input(
      z
        .object({
          ids: z.array(z.string().uuid()).optional(),
          profileSlug: z.string().optional(),
          workspaceId: z.string().uuid().nullable().optional(),
        })
        .refine(
          (v) => (v.ids?.length ?? 0) > 0 || v.profileSlug !== undefined,
          "Provide ids or profileSlug"
        )
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      const conditions: any[] = [];
      if (input.ids?.length) {
        conditions.push(inArray(entities.id, input.ids));
      }
      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }
      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (input.workspaceId) {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }
      const deleted = await database
        .delete(entities)
        .where(and(...conditions))
        .returning({ id: entities.id, documentId: entities.documentId });
      // B1: reclaim each hard-deleted entity's document + storage objects
      // (previously orphaned). Unconditional reverse-cascade via the one body
      // door; best-effort per row so one cleanup miss never aborts the batch.
      const bodyService = new EntityBodyService(database, eventRepository);
      for (const row of deleted) {
        if (row.documentId) {
          await bodyService
            .deleteBody({ documentId: row.documentId })
            .catch(() => {});
        }
      }
      console.log(
        `[pod-admin] adminBatchDelete: ${deleted.length} entities permanently deleted`
      );
      return { deletedCount: deleted.length };
    }),

  /**
   * Admin: list profile slugs with entity counts (for the profile filter).
   */
  adminListProfiles: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.union([z.string().uuid(), z.null()]).optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [isNull(entities.deletedAt)];
      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }

      const rows = await db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`count(*)::int`,
        })
        .from(entities)
        .where(and(...conditions))
        .groupBy(entities.type)
        .orderBy(desc(drizzleSql`count(*)`));

      return rows.map((r) => ({
        profileSlug: r.profileSlug,
        count: r.count,
      }));
    }),
};
