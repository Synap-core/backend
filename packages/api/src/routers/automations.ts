/**
 * Automations Router
 *
 * CRUD for workflow automations + run history.
 * Automations are created as drafts (typically by AI), then activated by the user.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  getDb,
  eq,
  and,
  desc,
  automations,
  automationRuns,
  automationStepRuns,
} from "@synap/database";
import { TRPCError } from "@trpc/server";

/**
 * Compute next cron run time by forward-scanning from a base date.
 * Supports standard 5-field cron (minute hour dayOfMonth month dayOfWeek).
 */
function computeNextCronRunAt(cronExpr: string, fromDate: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;
  const dayNames: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  };

  function matches(field: string, value: number): boolean {
    if (field === "*") return true;
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    for (const v of field.split(",")) {
      if (v.includes("-")) {
        const [s, e] = v.split("-").map(Number);
        if (value >= s && value <= e) return true;
        continue;
      }
      const resolved = dayNames[v.toUpperCase()] ?? parseInt(v, 10);
      if (resolved === value) return true;
    }
    return false;
  }

  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      matches(minExpr, candidate.getMinutes()) &&
      matches(hourExpr, candidate.getHours()) &&
      matches(domExpr, candidate.getDate()) &&
      matches(monthExpr, candidate.getMonth() + 1) &&
      matches(dowExpr, candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

export const automationsRouter = router({
  // ── List automations ────────────────────────────────────────────────────────

  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.enum(["draft", "active", "paused", "error"]).optional(),
          triggerType: z
            .enum(["event", "cron", "webhook", "manual"])
            .optional(),
          limit: z.number().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      const conditions = [eq(automations.workspaceId, ctx.workspaceId!)];

      if (input?.status) {
        conditions.push(eq(automations.status, input.status));
      }
      if (input?.triggerType) {
        conditions.push(eq(automations.triggerType, input.triggerType));
      }

      const rows = await database
        .select()
        .from(automations)
        .where(and(...conditions))
        .orderBy(desc(automations.updatedAt))
        .limit(input?.limit ?? 50);

      return { automations: rows };
    }),

  // ── Get single automation ───────────────────────────────────────────────────

  get: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      const row = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.id),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      return row;
    }),

  // ── Create automation ───────────────────────────────────────────────────────

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]),
        triggerConfig: z.record(z.string(), z.unknown()).default({}),
        flowDefinition: z.object({
          nodes: z.array(z.record(z.string(), z.unknown())),
          edges: z.array(z.record(z.string(), z.unknown())),
        }),
        status: z.enum(["draft", "active", "paused", "error"]).default("draft"),
        metadata: z.record(z.string(), z.unknown()).optional(),
        /** Explicit agent user ID for AI-created automations */
        agentUserId: z.string().uuid().optional(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const createdBy = input.agentUserId ?? ctx.userId!;

      const [row] = await database
        .insert(automations)
        .values({
          workspaceId: ctx.workspaceId!,
          createdBy,
          name: input.name,
          description: input.description,
          triggerType: input.triggerType,
          triggerConfig: input.triggerConfig,
          flowDefinition: input.flowDefinition as any,
          status: input.status,
          metadata: {
            ...(input.metadata ?? {}),
            createdVia:
              input.source === "agent" || input.source === "ai"
                ? "ai"
                : "manual",
          } as any,
        })
        .returning();

      return {
        status: "created",
        id: row.id,
        message: `Automation "${input.name}" created as ${input.status}`,
      };
    }),

  // ── Update automation ───────────────────────────────────────────────────────

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]).optional(),
        triggerConfig: z.record(z.string(), z.unknown()).optional(),
        flowDefinition: z
          .object({
            nodes: z.array(z.record(z.string(), z.unknown())),
            edges: z.array(z.record(z.string(), z.unknown())),
          })
          .optional(),
        status: z.enum(["draft", "active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      // Verify ownership
      const existing = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.id),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
        columns: { id: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }

      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.triggerType !== undefined)
        updates.triggerType = input.triggerType;
      if (input.triggerConfig !== undefined)
        updates.triggerConfig = input.triggerConfig;
      if (input.flowDefinition !== undefined)
        updates.flowDefinition = input.flowDefinition;
      if (input.status !== undefined) updates.status = input.status;
      if (input.metadata !== undefined) updates.metadata = input.metadata;

      await database
        .update(automations)
        .set(updates)
        .where(eq(automations.id, input.id));

      return {
        status: "updated",
        message: `Automation updated`,
      };
    }),

  // ── Delete automation ───────────────────────────────────────────────────────

  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.id),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
        columns: { id: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }

      await database.delete(automations).where(eq(automations.id, input.id));

      return { status: "deleted" };
    }),

  // ── Activate / Pause ───────────────────────────────────────────────────────

  activate: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.id),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      if (existing.status === "active") {
        return { status: "already_active" };
      }

      // For cron triggers, compute the next run time
      let nextRunAt: Date | null = null;
      if (existing.triggerType === "cron") {
        const triggerConfig = existing.triggerConfig as Record<string, unknown>;
        const cronExpression = triggerConfig?.expression as string | undefined;
        if (cronExpression) {
          nextRunAt = computeNextCronRunAt(cronExpression, new Date());
        }
      }

      await database
        .update(automations)
        .set({
          status: "active",
          updatedAt: new Date(),
          errorMessage: null,
          ...(nextRunAt ? { nextRunAt } : {}),
        })
        .where(eq(automations.id, input.id));

      return { status: "activated", nextRunAt: nextRunAt?.toISOString() };
    }),

  pause: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.id),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
        columns: { id: true, status: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }

      await database
        .update(automations)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(automations.id, input.id));

      return { status: "paused" };
    }),

  // ── Runs: list ──────────────────────────────────────────────────────────────

  listRuns: workspaceProcedure
    .input(
      z.object({
        automationId: z.string().uuid(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();

      // Verify automation belongs to workspace
      const automation = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.automationId),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
        columns: { id: true },
      });
      if (!automation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }

      const rows = await database
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, input.automationId))
        .orderBy(desc(automationRuns.startedAt))
        .limit(input.limit ?? 20);

      return { runs: rows };
    }),

  // ── Runs: get with step runs ────────────────────────────────────────────────

  getRun: workspaceProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const database = await getDb();

      const run = await database.query.automationRuns.findFirst({
        where: and(
          eq(automationRuns.id, input.runId),
          eq(automationRuns.workspaceId, ctx.workspaceId!)
        ),
      });
      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Run not found",
        });
      }

      const steps = await database
        .select()
        .from(automationStepRuns)
        .where(eq(automationStepRuns.runId, run.id));

      return { run, steps };
    }),

  // ── Manual trigger ──────────────────────────────────────────────────────────

  trigger: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Optional payload to inject as trigger.payload in the execution context */
        payload: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const { getBoss } = await import("@synap/jobs");

      const existing = await database.query.automations.findFirst({
        where: and(
          eq(automations.id, input.id),
          eq(automations.workspaceId, ctx.workspaceId!)
        ),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      if (existing.status !== "active" && existing.triggerType !== "manual") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot trigger automation with status="${existing.status}". Must be active or manual trigger type.`,
        });
      }

      const [run] = await database
        .insert(automationRuns)
        .values({
          automationId: existing.id,
          workspaceId: ctx.workspaceId!,
          triggeredBy: ctx.userId!,
          triggerPayload: {
            type: "manual",
            triggeredBy: ctx.userId!,
            timestamp: new Date().toISOString(),
            ...(input.payload ?? {}),
          },
          status: "running",
        })
        .returning({ id: automationRuns.id });

      const boss = getBoss();
      await boss.send("automation-execute", {
        runId: run.id,
        automationId: existing.id,
        workspaceId: ctx.workspaceId!,
        automationContext: {
          automationRunId: run.id,
          automationId: existing.id,
          chainDepth: 0,
          rootRunId: run.id,
          chainAutomationIds: [existing.id],
        },
      });

      return { status: "triggered", runId: run.id };
    }),
});
