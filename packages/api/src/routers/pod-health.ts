/**
 * Pod health — the Pod health page's door (pod admin, Pod group).
 *
 *   get            — the readings with their marks, the open alerts, the
 *                    thresholds and the host actions' state. A dry run of the
 *                    SAME evaluator the 2-min cron runs (`services/pod-health`).
 *   setThresholds  — change one or more metrics' warn / critical lines,
 *                    validated (1-100, warn below critical), merged into
 *                    `pod_settings.settings.resourceAlerts`.
 *   requestAction  — ask the host to trim the build cache, remove old release
 *                    images, or restart one service (never Postgres). Writes
 *                    a request file the host engine takes; never runs a host
 *                    command itself.
 *
 * Every procedure is pod-admin only (`podAdminProcedure`): host readings and
 * actions on the pod's machine are the pod's operator's, never a member's.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { router, podAdminProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { writePodSettingsKey } from "../services/media-copy/backfill-media-copy.js";
import {
  applyThresholdsPatch,
  HOST_ACTIONS,
  openResourceAlerts,
  readHostActionsStatus,
  readPodHealth,
  requestHostAction,
  RESOURCE_ALERTS_SETTING,
  RESTARTABLE_SERVICES,
  THRESHOLD_METRICS,
  type ThresholdMetric,
} from "../services/pod-health/index.js";

const logger = createLogger({ module: "pod-health-router" });

const pair = z.object({
  warn: z.number(),
  critical: z.number(),
});

export const podHealthRouter = router({
  get: podAdminProcedure.query(async () => {
    const [{ evaluation, thresholds }, actions] = await Promise.all([
      readPodHealth(),
      readHostActionsStatus(),
    ]);
    const { explicit, ...values } = thresholds;
    return {
      level: evaluation.level,
      hostState: evaluation.hostState,
      hostSampledAt: evaluation.hostSampledAt,
      evaluatedAt: evaluation.state.evaluatedAt,
      readings: evaluation.readings,
      alerts: openResourceAlerts(evaluation),
      thresholds: values,
      customized: explicit,
      actions,
      restartableServices: [...RESTARTABLE_SERVICES],
    };
  }),

  setThresholds: podAdminProcedure
    .input(
      z
        .object(
          Object.fromEntries(
            THRESHOLD_METRICS.map((m) => [m, pair.optional()])
          ) as Record<ThresholdMetric, z.ZodOptional<typeof pair>>
        )
        .strict()
    )
    .mutation(async ({ input }) => {
      const { thresholds } = await readPodHealth();
      const { explicit: _explicit, ...current } = thresholds;
      const next = applyThresholdsPatch(current, input);
      if (!next.ok) {
        // The page checks the same rule before it sends (its model); this
        // is the authority. The message names each refused metric.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `thresholds_invalid: ${Object.entries(next.problems)
            .map(([metric, problem]) => `${metric}=${problem}`)
            .join(", ")}`,
        });
      }
      await writePodSettingsKey(RESOURCE_ALERTS_SETTING, next.thresholds);
      return { thresholds: next.thresholds };
    }),

  requestAction: podAdminProcedure
    .input(
      z.object({
        action: z.enum(HOST_ACTIONS),
        service: z.string().max(40).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const result = await requestHostAction({
        action: input.action,
        service: input.service,
        requestedBy: userId,
      });
      if (!result.ok) {
        throw new TRPCError({
          code:
            result.reason === "busy"
              ? "CONFLICT"
              : result.reason === "service_not_allowed"
                ? "BAD_REQUEST"
                : "PRECONDITION_FAILED",
          message: result.reason,
        });
      }
      logger.info(
        {
          requestId: result.request.id,
          action: result.request.action,
          service: result.request.service,
          userId,
        },
        "Host action requested"
      );
      return { request: result.request };
    }),
});
