/**
 * Approvals Router
 *
 * Handles listing and reviewing pending approval requests.
 * Uses events table metadata for approvals (no separate table needed).
 */

import { router, protectedProcedure } from "../trpc.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "@synap/database";
import { events } from "@synap/database/schema";
import { inngest } from "@synap/jobs";

export const approvalsRouter = router({
  /**
   * List pending approvals for current user
   *
   * Returns all .requested events where:
   * - User is in approvers list
   * - Status is 'pending'
   */
  listPending: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Query events where user is an approver
      // Using raw SQL for JSONB queries
      const result = await ctx.db.execute(sql`
        SELECT * FROM events
        WHERE 
          metadata->>'approvalStatus' = 'pending'
          AND ${ctx.userId} = ANY(string_to_array(metadata->>'approvers', ','))
          ${input.workspaceId ? sql`AND metadata->>'workspaceId' = ${input.workspaceId}` : sql``}
        ORDER BY timestamp DESC
        LIMIT 100
      `);

      const pendingApprovals = result.rows as (typeof events.$inferSelect)[];

      return pendingApprovals.map((event: typeof events.$inferSelect) => ({
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        requestedBy: event.userId,
        resource: event.subjectType,
        resourceId: event.subjectId,
        data: event.data,
        metadata: event.metadata,
      }));
    }),

  /**
   * List all approval requests for a workspace (admin view)
   */
  listAll: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        status: z.enum(["pending", "approved", "denied", "all"]).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Require admin role
      const { requireAdmin } = await import("@synap/database");
      await requireAdmin(ctx.db, input.workspaceId, ctx.userId);

      const result = await ctx.db.execute(sql`
        SELECT * FROM events
        WHERE 
          metadata->>'workspaceId' = ${input.workspaceId}
          AND type LIKE '%.requested'
          ${input.status && input.status !== "all" ? sql`AND metadata->>'approvalStatus' = ${input.status}` : sql``}
        ORDER BY timestamp DESC
        LIMIT 500
      `);

      const approvals = result.rows as (typeof events.$inferSelect)[];

      return approvals.map((event: typeof events.$inferSelect) => ({
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        requestedBy: event.userId,
        resource: event.subjectType,
        resourceId: event.subjectId,
        data: event.data,
        metadata: event.metadata,
      }));
    }),

  /**
   * Approve or deny a pending request
   */
  review: protectedProcedure
    .input(
      z.object({
        eventId: z.string().uuid(),
        decision: z.enum(["approve", "deny"]),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Get the event
      const [event] = await ctx.db
        .select()
        .from(events)
        .where(eq(events.id, input.eventId))
        .limit(1);

      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Approval request not found",
        });
      }

      // Check if user is an approver
      const approvers = (event.metadata?.approvers as string[]) || [];
      if (!approvers.includes(ctx.userId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not authorized to review this request",
        });
      }

      // Check if still pending
      if (event.metadata?.approvalStatus !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Request already ${event.metadata?.approvalStatus}`,
        });
      }

      // Update event metadata
      const newMetadata = {
        ...event.metadata,
        approvalStatus: input.decision === "approve" ? "approved" : "denied",
        reviewedBy: ctx.userId,
        reviewedAt: new Date().toISOString(),
        reviewReason: input.reason,
      };

      await ctx.db
        .update(events)
        .set({ metadata: newMetadata })
        .where(eq(events.id, input.eventId));

      // If approved, emit .validated event
      if (input.decision === "approve") {
        await inngest.send({
          name: event.type.replace(".requested", ".validated"),
          data: event.data,
          user: { id: event.userId },
        });
      }

      // If denied, emit .denied event
      if (input.decision === "deny") {
        await inngest.send({
          name: event.type.replace(".requested", ".denied"),
          data: {
            ...event.data,
            denialReason: input.reason,
          },
          user: { id: event.userId },
        });
      }

      return {
        success: true,
        decision: input.decision,
        eventType: event.type,
      };
    }),

  /**
   * Get approval statistics for a workspace
   */
  stats: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        timeRange: z.enum(["day", "week", "month"]).default("month"),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Require viewer role
      const { requireViewer } = await import("@synap/database");
      await requireViewer(ctx.db, input.workspaceId, ctx.userId);

      const timeRanges = {
        day: "1 day",
        week: "7 days",
        month: "30 days",
      };

      // Get approval counts by status
      const stats = await ctx.db.execute(sql`
        SELECT 
          metadata->>'approvalStatus' as status,
          COUNT(*) as count
        FROM events
        WHERE 
          metadata->>'workspaceId' = ${input.workspaceId}
          AND type LIKE '%.requested'
          AND timestamp > NOW() - INTERVAL '${timeRanges[input.timeRange]}'
        GROUP BY metadata->>'approvalStatus'
      `);

      return {
        pending: parseInt(
          stats.rows.find((r: any) => r.status === "pending")?.count || "0",
        ),
        approved: parseInt(
          stats.rows.find((r: any) => r.status === "approved")?.count || "0",
        ),
        denied: parseInt(
          stats.rows.find((r: any) => r.status === "denied")?.count || "0",
        ),
      };
    }),
});
