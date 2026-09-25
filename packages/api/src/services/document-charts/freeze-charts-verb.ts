/**
 * The READ behind `document.freeze_charts` (the builtin verb in
 * `capabilities/builtin-verbs.ts` the report flow runs between the assembler
 * and `create-report`; the freeze itself is `freeze-chart-embeds.ts`).
 *
 * THE READ IS THE LIVE CHART'S OWN QUERY. Each chart's rows come from the
 * `entities.list` procedure itself — the exact door the browser chart calls
 * (`useChartEntitiesQuery`: `{limit: 500, profileSlug}`) — invoked as the
 * run's acting user in the run's workspace. So the snapshot has the same
 * scope, filters, ordering and cap as the live chart a reader of the report
 * (opened in that workspace) would see, and it can never widen: the floor is
 * the procedure's own (`entityLensWhere` for the user + workspace).
 * Known difference: a reader's live chart reads under THEIR user floor; the
 * snapshot is taken under the report owner's. The owner wrote the report, so
 * it holds nothing the owner could not already see.
 *
 * Read-only: it returns markdown, it writes nothing (`create-report` does).
 */

import { db } from "@synap/database";
import type { Context } from "../../context.js";
import type { ChartEntitiesReader } from "./freeze-chart-embeds.js";

/** The cap the browser's live chart reads with (`CHART_ENTITIES_LIMIT`, @synap-core/stores). */
export const LIVE_CHART_ENTITIES_LIMIT = 500;

/** The live chart's read, as `userId` in `workspaceId`, through `entities.list`. */
export function liveChartReader(ctx: {
  userId: string;
  workspaceId: string | null;
}): ChartEntitiesReader {
  return async (profileSlug) => {
    const { entitiesRouter } = await import("../../routers/entities.js");
    const caller = entitiesRouter.createCaller({
      db,
      authenticated: true as const,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    } as unknown as Context);
    // Same input shape as the browser chart (`chartEntitiesListInput`): the
    // lens travels in the INPUT, not only the context.
    const result = await caller.list({
      limit: LIVE_CHART_ENTITIES_LIMIT,
      ...(profileSlug ? { profileSlug } : {}),
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    });
    return (result.entities ?? []) as unknown as Array<Record<string, unknown>>;
  };
}
