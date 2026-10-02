/**
 * posthog-analytics — the FIXED query program (pure, no I/O).
 *
 * WHY A FIXED PROGRAM AND NOT A HOGQL PASSTHROUGH
 * ----------------------------------------------
 * The obvious design — a `posthog.query({ hogql })` verb — is three defects at
 * once:
 *   1. INJECTION. HogQL text assembled from caller input is SQL injection with a
 *      different logo. Nothing between the caller and PostHog validates it.
 *   2. SCOPE. A passthrough also invites `projectId`/host parameters, which
 *      would let a caller point the pod's Personal API Key at ANOTHER PostHog
 *      project. Multi-tenancy dies the moment the project id is a call param.
 *   3. DISCOVERABILITY. An agent handed "write HogQL" needs to know the schema
 *      of a system it cannot see. It stalls, or guesses, and a guessed query
 *      that returns nothing is indistinguishable from a quiet week.
 *
 * So the capability ships a SMALL, NAMED, REVIEWED set of reads. Every HogQL
 * string here is a LITERAL (or is assembled from a validated integer / an
 * allow-listed event name, see `EVENT_NAME_PATTERN`). No caller string ever
 * reaches the query text unvalidated, and no caller can name a host or a
 * project:
 *
 *   - the HOST + PROJECT ID are install-time params, baked into the installed
 *     tool's `config.baseUrl` (`{{analyticsHost}}/api/projects/{{projectId}}`)
 *     by `createCapabilityFromDefinition`. They are NOT fields of any verb's
 *     parameter schema, and every schema is `.strict()`, so passing `projectId`
 *     is a hard rejection rather than a silently-ignored field.
 *   - the PATH is composed here, always relative. `triggerProviderAction`
 *     composes it under the tool's fixed `baseUrl` (a call-time absolute path is
 *     stripped), so there is no reachable host the install did not choose.
 *
 * This module is PURE — no db, no fetch, no env — so the security properties
 * above are unit-testable without a pod, a vault, or a live PostHog.
 */

import { z } from "zod";

/** The tool the capability installs; the handler dispatches through its name. */
export const POSTHOG_API_TOOL_NAME = "posthog_api";

/** Paths are RELATIVE — `config.baseUrl` on the installed tool supplies the root. */
export const POSTHOG_TREND_PATH = "/insights/trend/";
export const POSTHOG_QUERY_PATH = "/query/";

/** The HogQL column that identifies a person; used for every "unique users" read. */
const PERSON_COLUMN = "person_id";

/**
 * What an event name may contain when it is INLINED into HogQL as a string
 * literal.
 *
 * The allow-list is the whole injection defence, so it is deliberately narrow:
 * no quote (`'` or `"`), no backslash, no brace (`{`/`}` — HogQL placeholders),
 * no parenthesis, comma, semicolon, or `*` (so `/*` and `--`-style comment
 * tricks cannot be formed either). What remains covers real PostHog event names:
 * `$pageview`, `synap_deploy_verified`, `2fa_verified`, `checkout started`,
 * `synap:deploy`, `app/v2/open`.
 *
 * A name that does not match is REJECTED with the offending value echoed back —
 * never escaped-and-hoped. Rejecting is the honest failure: an event name the
 * pod cannot address is a finding, and silently mangling it would return a
 * confident zero.
 */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9_$][A-Za-z0-9_$.\- :/]{0,119}$/;

export const PostHogEventNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => EVENT_NAME_PATTERN.test(v), {
    message:
      "must be a PostHog event name (letters, digits, _$.- :/ only — no quotes or braces)",
  });

/** A read the capability can perform. */
export interface PostHogRequest {
  /** Only GET (trend insights) and POST (HogQL query) are ever produced. */
  method: "GET" | "POST";
  /** Relative path, query string included for GETs. Never a host. */
  path: string;
  /** JSON body for HogQL POSTs. */
  body?: Record<string, unknown>;
}

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * A failure of THIS capability's own contract: an unusable parameter, a PostHog
 * payload we cannot read, or an error PostHog returned inside a 200.
 *
 * Distinct from a transport failure (which the dispatcher reports as
 * `success:false`). Both end as a surfaced error — never as an empty result.
 */
export class PostHogQueryError extends Error {
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "PostHogQueryError";
    this.detail = detail;
  }
}

// ── the fixed program: parameters ────────────────────────────────────────────

const DaysSchema = z.coerce.number().int().min(1).max(90);
const IntervalSchema = z.enum(["hour", "day", "week"]);
const PositiveLimitSchema = z.coerce.number().int().min(1).max(100);

/**
 * `posthog.event_trend` — an event's volume over time.
 * `.strict()` is load-bearing: it is what makes `projectId`/`host`/`hogql`
 * passed by a caller a rejection instead of an ignored field.
 */
export const eventTrendParams = z
  .object({
    event: PostHogEventNameSchema,
    days: DaysSchema.optional(),
    interval: IntervalSchema.optional(),
  })
  .strict();

/** `posthog.unique_users` — unique people over time (defaults to `$pageview`). */
export const uniqueUsersParams = z
  .object({
    event: PostHogEventNameSchema.optional(),
    days: DaysSchema.optional(),
    interval: z.enum(["day", "week"]).optional(),
  })
  .strict();

/** `posthog.top_events` — the highest-volume events in the window. */
export const topEventsParams = z
  .object({
    days: DaysSchema.optional(),
    limit: PositiveLimitSchema.optional(),
  })
  .strict();

/** `posthog.step_reach` — unique people who performed each named step. */
export const stepReachParams = z
  .object({
    steps: z.array(PostHogEventNameSchema).min(2).max(8),
    days: DaysSchema.optional(),
  })
  .strict();

export type EventTrendInput = z.infer<typeof eventTrendParams>;
export type UniqueUsersInput = z.infer<typeof uniqueUsersParams>;
export type TopEventsInput = z.infer<typeof topEventsParams>;
export type StepReachInput = z.infer<typeof stepReachParams>;

const DEFAULT_EVENT = "$pageview";
const DEFAULT_DAYS = 7;
const DEFAULT_INTERVAL = "day" as const;
const DEFAULT_TOP_LIMIT = 10;

// ── the fixed program: request builders ──────────────────────────────────────

/**
 * A PostHog insights-trend request.
 *
 * `events` is a JSON document in a query parameter — NOT HogQL — so the event
 * name is carried as DATA and PostHog does its own parsing. `date_from` and
 * `interval` are enumerated/clamped values.
 */
function trendRequest(
  event: string,
  math: "total" | "dau",
  days: number,
  interval: "hour" | "day" | "week"
): PostHogRequest {
  const qs = new URLSearchParams();
  qs.set("events", JSON.stringify([{ id: event, type: "events", math }]));
  qs.set("date_from", `-${days}d`);
  qs.set("interval", interval);
  return { method: "GET", path: `${POSTHOG_TREND_PATH}?${qs.toString()}` };
}

/** `event` counts over time. */
export function buildEventTrendRequest(input: EventTrendInput): PostHogRequest {
  return trendRequest(
    input.event,
    "total",
    input.days ?? DEFAULT_DAYS,
    input.interval ?? DEFAULT_INTERVAL
  );
}

/** Unique people over time (`math:"dau"`). */
export function buildUniqueUsersRequest(
  input: UniqueUsersInput
): PostHogRequest {
  return trendRequest(
    input.event ?? DEFAULT_EVENT,
    "dau",
    input.days ?? DEFAULT_DAYS,
    input.interval ?? DEFAULT_INTERVAL
  );
}

/**
 * The top-events query. STATIC apart from two INTEGERS that are clamped before
 * they are inlined — a number is not an injection surface.
 */
export function topEventsHogQL(days: number, limit: number): string {
  return (
    "SELECT event, count() AS event_count FROM events " +
    `WHERE timestamp >= now() - INTERVAL ${days} DAY ` +
    `GROUP BY event ORDER BY event_count DESC LIMIT ${limit}`
  );
}

export function buildTopEventsRequest(input: TopEventsInput): PostHogRequest {
  const days = input.days ?? DEFAULT_DAYS;
  const limit = input.limit ?? DEFAULT_TOP_LIMIT;
  return {
    method: "POST",
    path: POSTHOG_QUERY_PATH,
    body: {
      query: { kind: "HogQLQuery", query: topEventsHogQL(days, limit) },
    },
  };
}

/**
 * The step-reach query. Every step name has ALREADY passed
 * `EVENT_NAME_PATTERN` (the Zod schema parses before this is called), so
 * single-quoting it cannot terminate the literal: no quote, no backslash, no
 * newline can occur inside it.
 *
 * It measures REACH, not ordering: a person counts for a step if they performed
 * that event anywhere in the window. That is deliberately the weaker, provable
 * claim — an ordered funnel needs either PostHog's funnel insight endpoint or
 * ClickHouse's `windowFunnel`, and neither could be verified against a live
 * instance (no Personal API Key exists yet). Shipping a guessed aggregate would
 * make a broken funnel read as a calm zero. See the module report.
 */
export function stepReachHogQL(steps: readonly string[], days: number): string {
  const columns = steps
    .map(
      (step, i) =>
        `count(DISTINCT CASE WHEN event = '${step}' THEN ${PERSON_COLUMN} END) AS step_${i + 1}_users`
    )
    .join(", ");
  const literals = steps.map((s) => `'${s}'`).join(", ");
  return (
    `SELECT ${columns} FROM events ` +
    `WHERE timestamp >= now() - INTERVAL ${days} DAY AND event IN (${literals})`
  );
}

export function buildStepReachRequest(input: StepReachInput): PostHogRequest {
  return {
    method: "POST",
    path: POSTHOG_QUERY_PATH,
    body: {
      query: {
        kind: "HogQLQuery",
        query: stepReachHogQL(input.steps, input.days ?? DEFAULT_DAYS),
      },
    },
  };
}

// ── the fixed program: response readers ──────────────────────────────────────
//
// AN EMPTY RESULT AND A FAILED READ ARE DIFFERENT FACTS. Every reader below
// throws when the payload is not the shape it claims to be, so an unreadable
// answer can never be rendered as "no data": an empty array from a 200 is a
// real empty, and anything else is noise we refuse to launder.

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PostHogQueryError(
      `PostHog returned an unreadable ${what} (expected an object).`,
      `received ${Array.isArray(value) ? "array" : typeof value}`
    );
  }
  return value as Record<string, unknown>;
}

/**
 * An application-level failure PostHog reports INSIDE a 200 body. Never read as
 * success: `{"error": "..."}` / `{"detail": "..."}` with no `results` is a
 * failure with a reason.
 */
function embeddedError(body: Record<string, unknown>): string | undefined {
  for (const key of ["error", "detail"] as const) {
    const v = body[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** A HogQL result table: PostHog returns `{ columns, results }`. */
export interface PostHogTable {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export function readHogQLTable(body: unknown): PostHogTable {
  const root = asRecord(body, "HogQL response");
  const results = root.results;
  if (!Array.isArray(results)) {
    const reason = embeddedError(root);
    throw new PostHogQueryError(
      reason
        ? `PostHog rejected the query: ${reason}`
        : "PostHog returned a HogQL response with no `results` array.",
      reason ? "embedded error" : JSON.stringify(Object.keys(root))
    );
  }
  const rawColumns = root.columns;
  if (!Array.isArray(rawColumns)) {
    throw new PostHogQueryError(
      "PostHog returned HogQL rows with no `columns` array, so the rows cannot be named."
    );
  }
  const columns = rawColumns.map((c) => String(c));
  const rows = results.map((row, i) => {
    if (Array.isArray(row)) {
      const out: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        out[col] = row[idx] ?? null;
      });
      return out;
    }
    if (row !== null && typeof row === "object") {
      return row as Record<string, unknown>;
    }
    throw new PostHogQueryError(
      `PostHog returned an unreadable HogQL row at index ${i}.`
    );
  });
  return { columns, rows, rowCount: rows.length };
}

/** One series of a PostHog trend insight. */
export interface PostHogTrendSeries {
  label: string | null;
  count: number | null;
  /** Bucket labels/keys, when PostHog supplies them. */
  labels: string[] | null;
  /** Raw bucket values — NOT reinterpreted, so nothing is guessed. */
  data: unknown[];
}

export interface PostHogTrend {
  series: PostHogTrendSeries[];
  seriesCount: number;
}

export function readTrend(body: unknown): PostHogTrend {
  const root = asRecord(body, "trend response");
  const result = root.result;
  if (!Array.isArray(result)) {
    const reason = embeddedError(root);
    throw new PostHogQueryError(
      reason
        ? `PostHog rejected the insight query: ${reason}`
        : "PostHog returned a trend response with no `result` array.",
      reason ? "embedded error" : JSON.stringify(Object.keys(root))
    );
  }
  const series = result.map((entry, i) => {
    const rec = asRecord(entry, `trend series at index ${i}`);
    const data = rec.data;
    if (!Array.isArray(data)) {
      throw new PostHogQueryError(
        `PostHog returned a trend series (index ${i}) with no \`data\` array.`
      );
    }
    const labels = Array.isArray(rec.labels)
      ? rec.labels.map((l) => String(l))
      : Array.isArray(rec.days)
        ? rec.days.map((l) => String(l))
        : null;
    return {
      label: typeof rec.label === "string" ? rec.label : null,
      count: typeof rec.count === "number" ? rec.count : null,
      labels,
      data,
    };
  });
  return { series, seriesCount: series.length };
}

/**
 * Project a step-reach table onto `{ step, event, users }` rows.
 *
 * `steps` is echoed from the CALLER's own (already validated) input, so the
 * mapping cannot drift: the column names come from the same array the HogQL was
 * built from. A missing column is a shape failure, not a zero.
 */
export function readStepReach(
  table: PostHogTable,
  steps: readonly string[]
): Array<{ step: number; event: string; users: number }> {
  const row = table.rows[0];
  if (!row) {
    throw new PostHogQueryError(
      "PostHog returned no row for the step-reach query (expected exactly one)."
    );
  }
  return steps.map((step, i) => {
    const column = `step_${i + 1}_users`;
    if (!(column in row)) {
      throw new PostHogQueryError(
        `PostHog's step-reach row is missing the \`${column}\` column.`
      );
    }
    const raw = row[column];
    const users = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(users)) {
      throw new PostHogQueryError(
        `PostHog's \`${column}\` is not a number (${JSON.stringify(raw)}).`
      );
    }
    return { step: i + 1, event: step, users };
  });
}
