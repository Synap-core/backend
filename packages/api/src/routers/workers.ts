/**
 * workers — stage workers enabled on a lifecycle (work model L4).
 *
 *   workers.list      — the enabled workers (space-wide + per project) for a
 *                       kind/role, a project or a track: state, scope, backlog.
 *   workers.enable    — enable a declared worker for a project or a track
 *                       (WORKBENCH act; refused on overlap, naming the holder).
 *   workers.setPaused — pause / resume one enablement (supervise act).
 *
 * The service is `services/playbooks/workers.ts` (one rule per enablement,
 * through the governed rule door). An agent caller files a proposal.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { WORKER_SCOPES, WORKER_SIZES } from "@synap-core/types/workers";
import {
  WorkerScopeOverlapError,
  enableWorker,
  listEnabledWorkers,
  setWorkerPaused,
} from "../services/playbooks/workers.js";

const activatorWire = z.object({
  on: z.enum(["created", "enters_status", "count", "schedule", "manual"]),
  status: z.string().optional(),
  cron: z.string().optional(),
  min: z.number().optional(),
  size: z.enum(WORKER_SIZES).optional(),
  mode: z.enum(["run", "propose"]),
  maxPendingApprovals: z.number().optional(),
});

const enabledWorkerWire = z.object({
  /** The rule — what `setPaused` acts on. */
  ruleId: z.string(),
  playbookId: z.string(),
  playbookName: z.string(),
  activatorKey: z.string(),
  /** Null when the playbook no longer declares it. */
  activator: activatorWire.nullable(),
  profileSlug: z.string().nullable(),
  size: z.enum(WORKER_SIZES),
  mode: z.enum(["run", "propose"]),
  scope: z.enum(WORKER_SCOPES),
  projectId: z.string().nullable(),
  trackId: z.string().nullable(),
  state: z.enum(["running", "paused"]),
  automationId: z.string().nullable(),
  pendingApprovals: z.number(),
  maxPendingApprovals: z.number(),
});

export type EnabledWorkerWire = z.infer<typeof enabledWorkerWire>;

export const workersRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        profileSlug: z.string().min(1).optional(),
        projectId: z.string().uuid().optional(),
        trackId: z.string().uuid().optional(),
        playbookId: z.string().uuid().optional(),
        liveOnly: z.boolean().default(false),
      })
    )
    .output(z.array(enabledWorkerWire))
    .query(async ({ ctx, input }) =>
      listEnabledWorkers({ userId: requireUserId(ctx.userId), ...input })
    ),

  enable: protectedProcedure
    .input(
      z
        .object({
          playbookId: z.string().uuid(),
          /** The declared activator's key (`activatorKey`). */
          activatorKey: z.string().min(1),
          projectId: z.string().uuid().optional(),
          trackId: z.string().uuid().optional(),
        })
        .refine((i) => !!i.projectId || !!i.trackId, {
          message: "Enable a worker for a project or a track.",
        })
    )
    .output(
      z.discriminatedUnion("status", [
        z.object({
          status: z.literal("enabled"),
          ruleId: z.string(),
          reactivated: z.boolean(),
        }),
        z.object({ status: z.literal("proposed"), proposalId: z.string() }),
        z.object({ status: z.literal("denied"), reason: z.string() }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await enableWorker({
          userId: requireUserId(ctx.userId),
          agentUserId: ctx.agentUserId ?? null,
          ...input,
        });
      } catch (err) {
        if (err instanceof WorkerScopeOverlapError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: err.message,
            cause: err,
          });
        }
        throw err;
      }
    }),

  setPaused: protectedProcedure
    .input(z.object({ ruleId: z.string().uuid(), paused: z.boolean() }))
    .output(
      z.discriminatedUnion("status", [
        z.object({
          status: z.literal("updated"),
          state: z.enum(["running", "paused"]),
        }),
        z.object({ status: z.literal("proposed"), proposalId: z.string() }),
        z.object({ status: z.literal("denied"), reason: z.string() }),
      ])
    )
    .mutation(async ({ ctx, input }) =>
      setWorkerPaused({
        userId: requireUserId(ctx.userId),
        agentUserId: ctx.agentUserId ?? null,
        ...input,
      })
    ),
});
