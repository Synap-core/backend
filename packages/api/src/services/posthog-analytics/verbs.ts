/**
 * posthog-analytics — the read-only builtin verb RUNNERS.
 *
 * WHY THESE ARE BUILTIN (Tier-0) AND NOT DECLARATIVE
 * --------------------------------------------------
 * The capability is a marketplace PACKAGE (published to the CP catalog as
 * `category:"capability"`, installed through the ONE door), but its four verbs
 * run in-process on the pod. Three reasons, each load-bearing:
 *
 *   1. THEIR PRIMARY ENDPOINT IS A POST READ. PostHog's aggregate read surface
 *      is `POST /api/projects/:id/query/` (HogQL). The declarative provider path
 *      classifies any non-GET as a WRITE (`execute-provider-verb.ts`), so an
 *      agent's analytics lookup would be filed as a review proposal and stall —
 *      the exact failure `metadata.readOnly` was introduced to fix for
 *      `exa_search`, except that declaration only reaches the SKILL gate and not
 *      the tool dispatch. A builtin verb is registered in
 *      `READ_ONLY_BUILTIN_VERBS`, which is the hand-audited "reads only" set the
 *      gate consults, and its handler dispatches with `alreadyApproved: true`
 *      (see client.ts). No governance was widened to make this work.
 *
 *   2. THE QUERY PROGRAM MUST BE FIXED. A declarative `providerSpec` can only be
 *      a static request template; the top-events / step-reach reads are
 *      generated HogQL. Generating them in TypeScript is what allows the
 *      allow-list + integer clamping that make them injection-free, and the
 *      response readers that keep "empty" and "failed" apart.
 *
 *   3. NO INTELLIGENCE SERVICE HOP. `kind:"code"` verbs round-trip through the IS
 *      sandbox and need an egress allow-list; a deterministic credentialed HTTP
 *      read has no business there.
 *
 * Everything that leaves the pod goes through the SAME dispatcher a declarative
 * verb uses (`triggerProviderAction`), so the vault policy, the fixed
 * destination, and the SSRF guard are shared, not re-implemented.
 */

import { TRPCError } from "@trpc/server";
import type { BuiltinVerbContext } from "../capabilities/builtin-verbs.js";
import {
  buildEventTrendRequest,
  buildStepReachRequest,
  buildTopEventsRequest,
  buildUniqueUsersRequest,
  eventTrendParams,
  readHogQLTable,
  readStepReach,
  readTrend,
  stepReachParams,
  topEventsParams,
  uniqueUsersParams,
} from "./query-program.js";
import {
  callPostHog,
  isPostHogReadFailure,
  trpcCodeFor,
  type PostHogReadContext,
} from "./client.js";

/**
 * Mirrors `BuiltinVerbHandler` without importing it as a value (no load cycle).
 *
 * NOTE the split this type implies: the RUNNERS exported here hold the
 * behaviour, while the `const <verb>Handler` DECLARATIONS that `BUILTIN_VERBS`
 * points at live in `builtin-verbs.ts`. That is a constraint of three
 * source-scanning tripwires which require every registered handler value to be a
 * `const` declared in that file (a spread or a bare re-export makes the map
 * unreadable to them, and they refuse rather than skip). Those declarations are
 * one-line delegations — never a second implementation.
 */
export type PostHogVerbHandler = (
  params: Record<string, unknown>,
  ctx: BuiltinVerbContext
) => Promise<unknown>;

/**
 * Run ONE verb body, converting this capability's failures into a tRPC error so
 * the Hub REST door keeps its status-code contract (412 = a human must fix the
 * configuration, 409 = retry, 500 = PostHog is broken or answered something
 * unreadable).
 *
 * The wrapper covers the WHOLE body — dispatch AND response reading — because a
 * payload we cannot parse is just as much a FAILED READ as a 500, and a reader
 * that threw a bare `Error` would reach the door as an opaque 500 with no
 * classification. The throw is the point: an analytics verb that returned `[]`
 * on a 401, or on an unreadable body, would render as a confident empty
 * dashboard.
 */
async function readOrThrow<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isPostHogReadFailure(err)) {
      throw new TRPCError({
        code: trpcCodeFor(err),
        message: err.message,
        cause: err,
      });
    }
    // A Zod param rejection and anything else unexpected keep their own shape.
    throw err;
  }
}

/** The acting identity the credentialed dispatcher needs. */
function readContext(ctx: BuiltinVerbContext): PostHogReadContext {
  return {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId ?? null,
  };
}

/** `posthog.event_trend` — one event's volume over time. */
export const runPostHogEventTrend: PostHogVerbHandler = async (params, ctx) =>
  readOrThrow(async () => {
    const input = eventTrendParams.parse(params);
    const days = input.days ?? 7;
    const interval = input.interval ?? "day";
    const body = await callPostHog(
      buildEventTrendRequest(input),
      readContext(ctx)
    );
    const trend = readTrend(body);
    return {
      verb: "posthog.event_trend",
      event: input.event,
      window: { days, interval },
      metric: "total",
      series: trend.series,
      seriesCount: trend.seriesCount,
      // An empty read is NOT an error: the query ran and matched nothing. It stays
      // distinguishable from a failure because a failure THROWS (above).
      empty: trend.seriesCount === 0,
    };
  });

/** `posthog.unique_users` — unique people over time. */
export const runPostHogUniqueUsers: PostHogVerbHandler = async (params, ctx) =>
  readOrThrow(async () => {
    const input = uniqueUsersParams.parse(params);
    const days = input.days ?? 7;
    const interval = input.interval ?? "day";
    const body = await callPostHog(
      buildUniqueUsersRequest(input),
      readContext(ctx)
    );
    const trend = readTrend(body);
    return {
      verb: "posthog.unique_users",
      event: input.event ?? "$pageview",
      window: { days, interval },
      metric: "unique_users",
      series: trend.series,
      seriesCount: trend.seriesCount,
      empty: trend.seriesCount === 0,
    };
  });

/** `posthog.top_events` — the highest-volume events in the window. */
export const runPostHogTopEvents: PostHogVerbHandler = async (params, ctx) =>
  readOrThrow(async () => {
    const input = topEventsParams.parse(params);
    const days = input.days ?? 7;
    const limit = input.limit ?? 10;
    const body = await callPostHog(
      buildTopEventsRequest(input),
      readContext(ctx)
    );
    const table = readHogQLTable(body);
    return {
      verb: "posthog.top_events",
      window: { days },
      limit,
      columns: table.columns,
      rows: table.rows,
      rowCount: table.rowCount,
      empty: table.rowCount === 0,
    };
  });

/**
 * `posthog.step_reach` — unique people who performed each named step in the
 * window. REACH, not ordering; the name says so and so does the description.
 */
export const runPostHogStepReach: PostHogVerbHandler = async (params, ctx) =>
  readOrThrow(async () => {
    const input = stepReachParams.parse(params);
    const days = input.days ?? 7;
    const body = await callPostHog(
      buildStepReachRequest(input),
      readContext(ctx)
    );
    const steps = readStepReach(readHogQLTable(body), input.steps);
    return {
      verb: "posthog.step_reach",
      window: { days },
      steps,
      // Reach, not a conversion rate: reporting a rate would need an ordering this
      // read does not claim.
      empty: steps.every((s) => s.users === 0),
    };
  });
