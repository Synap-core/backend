/**
 * posthog-analytics — barrel.
 *
 * The capability's pod-side runtime: a FIXED, scope-pinned read program, one
 * credentialed dispatcher, and four read-only builtin verbs. See `verbs.ts` for
 * why these run in-process rather than declaratively, and the capability
 * definition at `templates/capabilities/posthog-analytics.capability.json` for
 * the marketplace package that installs it.
 */

export {
  POSTHOG_API_TOOL_NAME,
  POSTHOG_QUERY_PATH,
  POSTHOG_TREND_PATH,
  EVENT_NAME_PATTERN,
  PostHogEventNameSchema,
  PostHogQueryError,
  eventTrendParams,
  uniqueUsersParams,
  topEventsParams,
  stepReachParams,
  buildEventTrendRequest,
  buildUniqueUsersRequest,
  buildTopEventsRequest,
  buildStepReachRequest,
  topEventsHogQL,
  stepReachHogQL,
  readHogQLTable,
  readTrend,
  readStepReach,
  type PostHogRequest,
  type PostHogTable,
  type PostHogTrend,
  type PostHogTrendSeries,
  type EventTrendInput,
  type UniqueUsersInput,
  type TopEventsInput,
  type StepReachInput,
} from "./query-program.js";

export {
  callPostHog,
  classifyPostHogFailure,
  isPostHogReadFailure,
  trpcCodeFor,
  PostHogReadError,
  type PostHogReadContext,
  type PostHogTrpcCode,
} from "./client.js";

export {
  runPostHogEventTrend,
  runPostHogUniqueUsers,
  runPostHogTopEvents,
  runPostHogStepReach,
  type PostHogVerbHandler,
} from "./verbs.js";
