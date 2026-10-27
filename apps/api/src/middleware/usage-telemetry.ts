/**
 * USAGE TELEMETRY — count every call per key, client, conversation, limiter
 * class and outcome (0364 `api_usage_buckets`; pod-side plan 0d26a391 §6.2).
 *
 * Mounted ONCE, just OUTSIDE the rate limiter (`index.ts`), so it sees the
 * limiter's own 429 as well as every answer behind it. It is a separate
 * middleware on purpose: the limiter (`security.ts`, `rate-limit-classes.ts`)
 * is left untouched. It counts in memory and flushes once a minute in ONE
 * batched upsert (`flushApiUsage`); a request never writes to the database.
 *
 * Where each dimension comes from:
 *   - `limiter_key` — the limiter's own bucket identity (`buildRateLimitKey`),
 *     class prefix dropped and hashed, so a 429 answered BEFORE auth (no key
 *     id) still joins to its key through that key's authenticated rows;
 *   - `api_key_id`, conversation — the key-auth doors' own entries
 *     (`runWithCallingKey`, `runWithClientKey`) fill the request's usage slot
 *     (`runWithUsageSlot`, `@synap/database`), so MCP, Hub REST and tRPC with
 *     a key are read the same way and nothing is re-authenticated here;
 *   - `client` — `X-Synap-Client` (`synap-bridge/0.6.0`, `synap-cli/1.13.0`),
 *     else the conversation's harness (`claude-code`), else `unknown`;
 *   - `rl_class` — the limiter's class for the path; a 429 that names its
 *     class in its body (`{class}`) wins, since that is the bucket it spent.
 *
 * Health and metrics (`free`) are not counted.
 */

import type { MiddlewareHandler } from "hono";
import {
  ApiUsageCounter,
  db,
  flushApiUsage,
  runWithUsageSlot,
  usageOutcome,
  type ApiUsageRow,
  type UsageSlot,
} from "@synap/database";
import { conversationOfClientKey } from "@synap-core/types/agents";
import { createLogger } from "@synap-core/core";
import {
  buildRateLimitKey,
  classifyRateLimitPath,
  clientIp,
  hashBearerToken,
} from "./rate-limit-classes.js";

const logger = createLogger({ module: "usage-telemetry" });

/** The header a client names itself with: `<name>/<version>`. */
export const CLIENT_HEADER = "x-synap-client";
export const USAGE_FLUSH_INTERVAL_MS = 60_000;

/** A usable `X-Synap-Client` value (visible ASCII, capped), else undefined. */
export function normalizeClient(raw: string | null | undefined): string | undefined {
  const v = raw?.trim();
  return v && v.length <= 64 && /^[\x21-\x7E]+$/.test(v) ? v : undefined;
}

/** `claude-code:<uuid>` → `claude-code`; anything else → undefined. */
export function harnessOfConversation(conversation: string | null): string | undefined {
  if (!conversation) return undefined;
  const at = conversation.indexOf(":");
  const harness = at > 0 ? conversation.slice(0, at) : "";
  return /^[a-z][a-z0-9._-]{0,31}$/.test(harness) ? harness : undefined;
}

/**
 * The limiter's bucket identity without its class prefix, hashed:
 * `crud:key:<h>` → `key:<h>`; an address is hashed too (`ip:<h>`), so the
 * table never stores a client address.
 */
export function limiterIdentity(limiterKey: string, rlClass: string): string {
  const rest = limiterKey.startsWith(`${rlClass}:`)
    ? limiterKey.slice(rlClass.length + 1)
    : limiterKey;
  const sep = rest.indexOf(":");
  if (sep < 0) return `other:${hashBearerToken(rest)}`;
  const kind = rest.slice(0, sep);
  const value = rest.slice(sep + 1);
  return kind === "ip" ? `ip:${hashBearerToken(value)}` : `${kind}:${value}`;
}

/** The class a 429 says it spent (`{ class }` in its JSON body), if any. */
async function limitedClass(res: Response): Promise<string | undefined> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    return undefined;
  }
  try {
    const body = (await res.clone().json()) as { class?: unknown };
    return typeof body.class === "string" && /^[a-z_]{1,32}$/.test(body.class)
      ? body.class
      : undefined;
  } catch {
    // An unreadable 429 body still counts, under the path's class.
    return undefined;
  }
}

export interface UsageTelemetry {
  middleware: MiddlewareHandler;
  counter: ApiUsageCounter;
  /** Write what was counted, now (the timer and shutdown call it). */
  flushNow: () => Promise<number>;
  stop: () => void;
}

export function createUsageTelemetry(
  opts: {
    counter?: ApiUsageCounter;
    flush?: (rows: ApiUsageRow[]) => Promise<unknown>;
    intervalMs?: number;
    now?: () => number;
  } = {}
): UsageTelemetry {
  const counter = opts.counter ?? new ApiUsageCounter();
  const flush = opts.flush ?? ((rows: ApiUsageRow[]) => flushApiUsage(rows, db));
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing: Promise<number> | undefined;

  const flushNow = async (): Promise<number> => {
    if (flushing) return flushing;
    const rows = counter.drain();
    if (rows.length === 0) return 0;
    flushing = (async () => {
      try {
        await flush(rows);
        return rows.length;
      } catch (err) {
        // Kept for the next flush (bounded by the counter's cap), and said.
        for (const r of rows) counter.add(r);
        logger.error(
          { err, tuples: rows.length },
          "usage telemetry flush failed; counts kept for the next flush"
        );
        return 0;
      } finally {
        flushing = undefined;
      }
    })();
    return flushing;
  };

  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(() => {
      void flushNow();
      if (counter.dropped > 0) {
        logger.error(
          { dropped: counter.dropped },
          "usage telemetry dropped calls: too many distinct tuples since the last flush"
        );
        counter.dropped = 0;
      }
    }, opts.intervalMs ?? USAGE_FLUSH_INTERVAL_MS);
    timer.unref?.();
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    const pathClass = classifyRateLimitPath(c.req.path, c.req.method);
    if (pathClass === "free") return next();
    const started = now();
    const slot: UsageSlot = {};
    try {
      await runWithUsageSlot(slot, () => next());
    } finally {
      try {
        const status = c.res?.status ?? 500;
        const rlClass =
          (status === 429 && c.res ? await limitedClass(c.res) : undefined) ??
          pathClass;
        const limiterKey = limiterIdentity(
          buildRateLimitKey(
            pathClass,
            c.req.header("Authorization"),
            clientIp(c),
            c.req.path,
            c.req.header("Cookie")
          ),
          pathClass
        );
        const conversationId = conversationOfClientKey(slot.clientKey);
        counter.record(
          {
            apiKeyId: slot.apiKeyId ?? null,
            limiterKey,
            client:
              normalizeClient(c.req.header(CLIENT_HEADER)) ??
              harnessOfConversation(conversationId) ??
              "unknown",
            conversationId,
            rlClass,
            outcome: usageOutcome(status),
          },
          now() - started,
          started
        );
        ensureTimer();
      } catch (err) {
        // Counting never fails the request it counts; the miss is said.
        logger.error({ err }, "usage telemetry could not count a request");
      }
    }
  };

  return {
    middleware,
    counter,
    flushNow,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** The pod's one instance: mounted in `index.ts`, flushed on shutdown. */
export const usageTelemetry = createUsageTelemetry();
