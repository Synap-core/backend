/**
 * EVENT-LOOP WATCH — a blocked event loop is measured, and the request that
 * blocked it is named (plan "Pod resilience" G6).
 *
 * The incident (2026-11-03): one document read parsed a 126 MB video as
 * markdown and held the backend's single event loop for 60-110 s at a time,
 * for ~1.5 h. The logs showed only slow responses, Postgres showed queries
 * waiting in ClientRead, the healthcheck failed and the watchdog restarted the
 * container; the culprit was found only with a live CPU profile. `/metrics`
 * already carried prom-client's `nodejs_eventloop_lag_*` (collectDefaultMetrics,
 * `@synap-core/core/metrics.ts`), but nothing scraped it and nothing could say
 * WHICH request held the loop.
 *
 * What this adds:
 *   1. a watchdog timer (every `tickMs`, unref'd): when it fires later than
 *      `stallMs`, the loop was blocked, and ONE warn line `event loop blocked`
 *      names the requests that were running across the stall, longest first,
 *      capped at 10 — method, path (no query string, secret path segments
 *      redacted), how long each had run, its API key id and agent user id when
 *      the auth doors set them. Never a body, a header or a query string.
 *   2. `perf_hooks.monitorEventLoopDelay` (p50 / p99 / max) and
 *      `performance.eventLoopUtilization()` over a rolling window, read by
 *      /health (numbers only) and /status/release's details (plus the last
 *      stall's named requests).
 *
 * The request that blocks the loop often FINISHES inside the stall (its
 * handler returns right after the synchronous work), so its registry entry is
 * gone before the late timer can run. Entries that ended since the previous
 * tick are therefore kept until the next one (the same objects, bounded) and
 * count as "running across the stall" when they ended after it began.
 *
 * Overhead: one object per request, in a Set, removed in the caller's
 * `finally` (`usage-telemetry.ts`); a stall reads the registry only when it
 * logs. Both collections are capped.
 */

import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from "node:perf_hooks";
import { createLogger } from "@synap-core/core";
import { redactSecretPath } from "../middleware/redact-secret-path.js";

/** Every env knob this module reads (deploy wiring: event-loop-watch.test.ts). */
export const EVENT_LOOP_WATCH_KEYS = [
  "SYNAP_EVENT_LOOP_STALL_MS",
  "SYNAP_EVENT_LOOP_TICK_MS",
  "SYNAP_EVENT_LOOP_WINDOW_MS",
] as const;

export interface EventLoopWatchConfig {
  /** A tick later than this is a stall, and is logged. */
  stallMs: number;
  /** How often the watchdog timer fires. */
  tickMs: number;
  /** The rolling window of the delay percentiles and the utilization. */
  windowMs: number;
}

const BOUNDS: Record<
  (typeof EVENT_LOOP_WATCH_KEYS)[number],
  { default: number; min: number; max: number }
> = {
  SYNAP_EVENT_LOOP_STALL_MS: { default: 2_000, min: 100, max: 600_000 },
  SYNAP_EVENT_LOOP_TICK_MS: { default: 500, min: 50, max: 60_000 },
  SYNAP_EVENT_LOOP_WINDOW_MS: { default: 60_000, min: 1_000, max: 3_600_000 },
};

/** The `envInt` rule (`@synap/shared-utils`, not a dependency of this app). */
function intFromEnv(
  env: Record<string, string | undefined>,
  name: (typeof EVENT_LOOP_WATCH_KEYS)[number]
): number {
  const b = BOUNDS[name];
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return b.default;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < b.min) return b.default;
  return Math.min(n, b.max);
}

export function eventLoopWatchConfig(
  env: Record<string, string | undefined>
): EventLoopWatchConfig {
  return {
    stallMs: intFromEnv(env, "SYNAP_EVENT_LOOP_STALL_MS"),
    tickMs: intFromEnv(env, "SYNAP_EVENT_LOOP_TICK_MS"),
    windowMs: intFromEnv(env, "SYNAP_EVENT_LOOP_WINDOW_MS"),
  };
}

/** What a request's context can tell, read only when a stall is logged. */
interface ContextReader {
  get(key: string): unknown;
}

/** The usage slot (`@synap/database` UsageSlot) the key-auth doors fill. */
interface KeySlot {
  apiKeyId?: string;
}

/** One request in flight. Holds references only: nothing is copied per request. */
export interface InFlightEntry {
  method: string;
  /** `c.req.path`: the pathname, never the query string. Redacted when read. */
  path: string;
  startedAt: number;
  endedAt?: number;
  slot?: KeySlot;
  ctx?: ContextReader;
}

export interface NamedRequest {
  method: string;
  path: string;
  runningMs: number;
  /** true: it finished inside the stall (often the one that caused it). */
  ended: boolean;
  apiKeyId?: string;
  agentUserId?: string;
}

export interface StallReport {
  at: string;
  /** How late the watchdog fired: the loop was blocked at least this long. */
  blockedMs: number;
  /** Requests that ran across the stall (all of them, before the cap). */
  inFlight: number;
  requests: NamedRequest[];
}

export type DelayStats =
  | {
      state: "measured";
      windowStartedAt: string;
      windowMs: number;
      samples: number;
      /** Delay beyond the histogram's sampling interval, in ms. */
      p50Ms: number;
      p99Ms: number;
      maxMs: number;
    }
  | { state: "empty"; windowStartedAt: string }
  | { state: "unavailable"; reason: string };

export type UtilizationStats =
  | { state: "measured"; ratio: number; windowStartedAt: string }
  | { state: "unavailable"; reason: string };

export interface EventLoopSnapshot {
  delay: DelayStats;
  utilization: UtilizationStats;
  stalls: {
    thresholdMs: number;
    /** Stalls logged since the process started. */
    count: number;
    last:
      (Omit<StallReport, "requests"> & { requests?: NamedRequest[] }) | null;
  };
}

export interface EventLoopWatch {
  /** Register a request; pass the result to `end` in a `finally`. */
  begin(
    method: string,
    path: string,
    slot?: KeySlot,
    ctx?: ContextReader
  ): InFlightEntry | undefined;
  end(entry: InFlightEntry | undefined): void;
  start(): void;
  stop(): void;
  /** The watchdog body, exposed so a test can drive it with its own clock. */
  tick(): void;
  /** `named`: include the last stall's requests (diagnostics readers only). */
  snapshot(opts?: { named?: boolean }): EventLoopSnapshot;
}

/** Hard caps: a flood of requests never grows memory without bound. */
const MAX_IN_FLIGHT = 10_000;
const MAX_RECENTLY_ENDED = 2_000;
const MAX_NAMED = 10;
/** The delay histogram's sampling interval (ms); subtracted from its values. */
const HISTOGRAM_RESOLUTION_MS = 20;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function createEventLoopWatch(opts: {
  config: EventLoopWatchConfig;
  /** Where the stall line goes (a warn). */
  warn: (fields: Record<string, unknown>, msg: string) => void;
  now?: () => number;
  /** Applied to each path when it is logged or shown. */
  redactPath?: (path: string) => string;
  /** Injected in tests; defaults to `monitorEventLoopDelay`. */
  histogram?: () => IntervalHistogram;
  /** Injected in tests; defaults to `performance.eventLoopUtilization`. */
  utilization?: (prev?: EventLoopUtilization) => EventLoopUtilization;
}): EventLoopWatch {
  const { config, warn } = opts;
  const now = opts.now ?? Date.now;
  const redact = opts.redactPath ?? ((p: string) => p);
  const elu =
    opts.utilization ??
    ((prev?: EventLoopUtilization) => performance.eventLoopUtilization(prev));

  const inFlight = new Set<InFlightEntry>();
  let recentlyEnded: InFlightEntry[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTick = now();

  let histogram: IntervalHistogram | undefined;
  let histogramError = "the watch has not started";
  let windowStartedAt = now();
  let eluAtWindowStart: EventLoopUtilization | undefined;
  let eluError = "the watch has not started";
  let previousWindow: {
    delay: DelayStats;
    utilization: UtilizationStats;
  } | null = null;

  let stallCount = 0;
  let lastStall: StallReport | null = null;

  const readDelay = (): DelayStats => {
    if (!histogram) return { state: "unavailable", reason: histogramError };
    const startedAt = new Date(windowStartedAt).toISOString();
    // An empty histogram answers garbage (min 2^63, mean NaN): never a 0.
    if (histogram.count === 0) {
      return { state: "empty", windowStartedAt: startedAt };
    }
    const beyond = (ns: number) =>
      round1(Math.max(0, ns / 1e6 - HISTOGRAM_RESOLUTION_MS));
    return {
      state: "measured",
      windowStartedAt: startedAt,
      windowMs: now() - windowStartedAt,
      samples: histogram.count,
      p50Ms: beyond(histogram.percentile(50)),
      p99Ms: beyond(histogram.percentile(99)),
      maxMs: beyond(histogram.max),
    };
  };

  const readUtilization = (): UtilizationStats => {
    if (!eluAtWindowStart) return { state: "unavailable", reason: eluError };
    try {
      const ratio = elu(eluAtWindowStart).utilization;
      if (!Number.isFinite(ratio)) {
        return { state: "unavailable", reason: "no utilization sample yet" };
      }
      return {
        state: "measured",
        ratio: Math.round(ratio * 1000) / 1000,
        windowStartedAt: new Date(windowStartedAt).toISOString(),
      };
    } catch (err) {
      return {
        state: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const openWindow = () => {
    windowStartedAt = now();
    histogram?.reset();
    try {
      eluAtWindowStart = elu();
    } catch (err) {
      eluAtWindowStart = undefined;
      eluError = err instanceof Error ? err.message : String(err);
    }
  };

  /**
   * The requests that ran across a stall: still in flight, or ended since the
   * previous tick (the loop was free then, so the blocking began after it),
   * and started at least half the threshold before the late tick ran. The
   * request that held the loop for more than `stallMs` started at least that
   * long before the tick, wherever its start fell against the ticks (a
   * reference to the due time would miss one that started after a tick that
   * was itself late); a request that arrived after the block started only
   * the few callbacks the loop ran before its timers ago. Longest-running
   * first.
   */
  const nameRequests = (t: number) => {
    const startedBy = t - config.stallMs / 2;
    const across: Array<{ r: InFlightEntry; runningMs: number }> = [];
    const consider = (r: InFlightEntry) => {
      if (r.startedAt <= startedBy) {
        across.push({ r, runningMs: (r.endedAt ?? t) - r.startedAt });
      }
    };
    inFlight.forEach(consider);
    recentlyEnded.forEach(consider);
    across.sort((a, b) => b.runningMs - a.runningMs);
    const requests = across
      .slice(0, MAX_NAMED)
      .map(({ r, runningMs }): NamedRequest => {
        const agentUserId = r.ctx?.get("agentUserId");
        return {
          method: r.method,
          path: redact(r.path),
          runningMs,
          ended: r.endedAt !== undefined,
          ...(r.slot?.apiKeyId ? { apiKeyId: r.slot.apiKeyId } : {}),
          ...(typeof agentUserId === "string" && agentUserId
            ? { agentUserId }
            : {}),
        };
      });
    return { inFlight: across.length, requests };
  };

  const tick = () => {
    const t = now();
    const blockedMs = t - lastTick - config.tickMs;
    if (blockedMs > config.stallMs) {
      try {
        const named = nameRequests(t);
        stallCount += 1;
        lastStall = { at: new Date(t).toISOString(), blockedMs, ...named };
        warn(
          {
            blockedMs,
            stallThresholdMs: config.stallMs,
            inFlight: named.inFlight,
            requests: named.requests,
          },
          "event loop blocked"
        );
      } catch {
        // The watchdog never throws out of a timer; a stall it cannot name
        // still counts.
        stallCount += 1;
      }
    }
    lastTick = t;
    // An entry that ended before this tick cannot have run across the next
    // stall (that one begins after this tick).
    recentlyEnded = [];
    if (t - windowStartedAt >= config.windowMs) {
      previousWindow = { delay: readDelay(), utilization: readUtilization() };
      openWindow();
    }
  };

  return {
    begin(method, path, slot, ctx) {
      if (!timer || inFlight.size >= MAX_IN_FLIGHT) return undefined;
      const entry: InFlightEntry = {
        method,
        path,
        startedAt: now(),
        slot,
        ctx,
      };
      inFlight.add(entry);
      return entry;
    },
    end(entry) {
      if (!entry) return;
      inFlight.delete(entry);
      entry.endedAt = now();
      if (recentlyEnded.length < MAX_RECENTLY_ENDED) recentlyEnded.push(entry);
    },
    start() {
      if (timer) return;
      try {
        histogram = (
          opts.histogram ??
          (() => monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS }))
        )();
        histogram.enable();
      } catch (err) {
        histogram = undefined;
        histogramError = err instanceof Error ? err.message : String(err);
      }
      eluError = "no utilization sample yet";
      openWindow();
      lastTick = now();
      timer = setInterval(tick, config.tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      histogram?.disable();
      inFlight.clear();
      recentlyEnded = [];
    },
    tick,
    snapshot({ named = false } = {}) {
      const current = { delay: readDelay(), utilization: readUtilization() };
      // The last FULL window once there is one; until then the partial one.
      const shown =
        previousWindow && previousWindow.delay.state !== "unavailable"
          ? previousWindow
          : current;
      let last: EventLoopSnapshot["stalls"]["last"] = null;
      if (lastStall) {
        const { requests, ...rest } = lastStall;
        last = named ? { ...rest, requests } : rest;
      }
      return {
        delay: shown.delay,
        utilization: shown.utilization,
        stalls: { thresholdMs: config.stallMs, count: stallCount, last },
      };
    },
  };
}

const watchLogger = createLogger({ module: "event-loop-watch" });

/**
 * The pod's one watch: `usage-telemetry.ts` registers each request,
 * `index.ts` starts it before `serve()`, stops it on shutdown, and reads it
 * on /health and /status/release.
 */
export const eventLoopWatch = createEventLoopWatch({
  config: eventLoopWatchConfig(process.env),
  warn: (fields, msg) => watchLogger.warn(fields, msg),
  redactPath: redactSecretPath,
});
