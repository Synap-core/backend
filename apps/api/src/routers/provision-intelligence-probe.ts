/**
 * Live reachability probe for the Intelligence Service.
 *
 * WHY THIS EXISTS. Three endpoints on this pod answer "is intelligence
 * connected?", and until now the only one the UI read was the only one that
 * never asked the IS:
 *
 *   GET /api/provision/status              — cached `intelligenceServices` rows
 *   GET /api/provision/diagnose-intelligence — live probe, behind a manual button
 *   GET /api/hub/health/dependencies       — live probe, ZERO client consumers
 *
 * So a pod whose IS answered in 3ms reported `connectionState: "disconnected"`
 * and every surface rendered "Connection issue — the pod lost its connection".
 * The record was empty; the connection was fine. A status derived from a stored
 * row instead of from the thing itself can only ever describe the row.
 *
 * This module is the ONE probe. `/status` and `/diagnose-intelligence` both use
 * it, so they can no longer disagree about the same fact.
 *
 * A probe is evidence about REACHABILITY only. It says the service answered —
 * not that credentials are valid, not that a chat turn would succeed. Callers
 * must not widen it into a claim it does not support.
 */

/** Result of one probe. `reachable` is the only field that is always present. */
export interface IntelligenceProbeResult {
  /** The service answered an HTTP request. Not a claim about credentials. */
  reachable: boolean;
  /** Status code, when one came back. */
  httpStatus?: number;
  /** Round-trip in ms, when the request completed. */
  latencyMs?: number;
  /** Why the probe failed, when it did. Never surfaced as a user-facing string. */
  error?: string;
}

/**
 * Default probe budget. Short on purpose: `/status` is a foreground call that
 * blocks a settings screen, and the IS is normally on the same private network
 * (3ms observed in production). A slow probe is a failed probe for this
 * purpose — the user is waiting.
 */
const DEFAULT_TIMEOUT_MS = 2_000;

/** How long a probe result is reused. Guards a polled `/status` from hammering. */
const CACHE_TTL_MS = 5_000;

const cache = new Map<
  string,
  { at: number; result: IntelligenceProbeResult }
>();

/**
 * Probe the IS's public `/health`. Never throws: an unreachable service is a
 * RESULT, not an error, and this runs inside request handlers that must still
 * return a status.
 */
export async function probeIntelligenceService(
  baseUrl: string | null,
  opts: {
    timeoutMs?: number;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    /** Skip the memo — diagnostics want a fresh answer. */
    noCache?: boolean;
  } = {}
): Promise<IntelligenceProbeResult> {
  if (!baseUrl) return { reachable: false, error: "no_url" };

  const now = Date.now();
  if (!opts.noCache) {
    const hit = cache.get(baseUrl);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.result;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  let result: IntelligenceProbeResult;
  try {
    const resp = await doFetch(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    result = {
      // The service ANSWERED. A non-2xx still proves something is listening and
      // routing, which is the question "is it reachable" asks; `httpStatus`
      // carries the nuance for callers that care.
      reachable: resp.ok,
      httpStatus: resp.status,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    result = {
      reachable: false,
      error:
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }

  cache.set(baseUrl, { at: now, result });
  return result;
}

/** Drop memoised results. For tests, and after a re-registration. */
export function clearIntelligenceProbeCache(): void {
  cache.clear();
}
