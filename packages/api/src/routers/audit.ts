/**
 * Audit Router
 *
 * Workspace-scoped read access to the pod's audit trail.
 *
 * The audit log itself lives in the `events` table — every state-changing
 * tRPC procedure (and every Hub Protocol write) calls `auditLog()` which
 * appends a row with `data.workspaceId` set. The pod-wide listing already
 * exists at `system.searchEvents` (podAdminProcedure). This router exposes
 * a single workspace-scoped lens on top of that data so workspace admins
 * can inspect changes affecting their workspace without seeing pod-wide
 * activity from workspaces they don't belong to.
 *
 * Pagination shape matches `system.searchEvents` so the same client UI
 * can render either lens by swapping the procedure call.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "../trpc.js";
import { eventRepository } from "@synap/database";

export const auditRouter = router({
  /**
   * List audit events scoped to ctx.workspaceId.
   *
   * Auth: workspaceProcedure (membership verified). We additionally require
   * admin/owner role — audit logs include who-did-what across the whole
   * workspace and are not appropriate for editor/viewer surfaces.
   *
   * Same return shape as `system.searchEvents`: `{ events, total, hasMore }`
   * (with `events` carrying the full event payload + pagination object).
   */
  listForWorkspace: workspaceProcedure
    .input(
      z.object({
        eventType: z.string().optional(),
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
        userId: z.string().optional(),
        fromDate: z.string().datetime().optional(),
        toDate: z.string().datetime().optional(),
        limit: z.number().min(1).max(1000).default(100),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace admin role required to view audit log",
        });
      }

      const filters = {
        userId: input.userId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        // Pod-wide listing filters by `data->>'workspaceId'` — same path here.
        workspaceId: ctx.workspaceId,
        fromDate: input.fromDate ? new Date(input.fromDate) : undefined,
        toDate: input.toDate ? new Date(input.toDate) : undefined,
        limit: input.limit,
        offset: input.offset,
      };

      const events = await eventRepository.searchEvents(filters);
      const total = await eventRepository.countEvents({
        userId: input.userId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        workspaceId: ctx.workspaceId,
        fromDate: filters.fromDate,
        toDate: filters.toDate,
      });

      return {
        events: events.map((event) => ({
          id: event.id,
          type: event.eventType,
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          subjectId: event.subjectId,
          subjectType: event.subjectType,
          data: event.data,
          metadata: event.metadata,
          causationId: event.causationId,
          correlationId: event.correlationId,
          source: event.source,
        })),
        total,
        hasMore: input.offset + events.length < total,
      };
    }),
});
