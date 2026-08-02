/**
 * Hub Protocol REST — GET /health/dependencies
 *
 * WHY A SECOND DOOR (and not a `?deps=1` flag on `/health`):
 *
 *  1. `/health` is the LIVENESS probe. It is unauthenticated, registered ahead
 *     of the auth middleware, and answers "is this process up" with zero I/O.
 *     Anything that can make it slower or flakier — a network call to another
 *     host — would make a container/orchestrator restart the pod because a
 *     *dependency* was down. A liveness probe must never depend on a peer.
 *     An opt-in query param keeps that risk one typo away (a probe configured
 *     with `?deps=1` silently becomes a readiness probe).
 *  2. This door is AUTHENTICATED (registered after the middleware and NOT in
 *     `skipAuthPaths`), for two reasons: it performs an outbound network call
 *     on request — unauthenticated, that is a free amplification lever against
 *     an internet-facing pod — and it discloses the resolved IS host. A key is
 *     no burden for the intended callers (`synap doctor`, the browser
 *     settings surface), which are already authenticated.
 *
 * The incident this exists for (2026-08-01): the IS went down, every capture
 * path died with 502, and `synap doctor` still reported "All checks passed"
 * because nothing on the pod ever reported a DEPENDENCY, only the hub itself.
 *
 * HONESTY RULES enforced here:
 *  - Never throws, never 500s. An unreachable dependency is a REPORTED state.
 *    A health endpoint that fails when a dependency fails cannot diagnose the
 *    exact thing it exists to diagnose.
 *  - Three distinct states, never collapsed: `reachable`, `unreachable`
 *    (resolved a URL, the probe failed) and `unresolved` (IS resolution itself
 *    failed — we do not know WHICH url to probe, so claiming "unreachable"
 *    would be a fabrication).
 *  - The probed URL comes from `resolveIntelligenceService` — the SAME
 *    resolution the real calls use (capability-first → workspace → user → pod
 *    default → env). Re-deriving an env var would mean probing a URL requests
 *    never touch, which is worse than no probe at all.
 */

import { z } from "@hono/zod-openapi";

import { resolveIntelligenceService } from "../../../utils/intelligence-routing.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

/** Probe budget. Short on purpose: this answers a question, it doesn't wait. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * ⚠️ CROSS-REPO CONTRACT — these literals are matched by STRING downstream.
 * `synap doctor` (synap-cli) finds this entry with `name === "intelligence-
 * service"` and branches on the three `state` values: `unreachable` tells the
 * user to restart/redeploy the IS, `unresolved` tells them to fix CONFIG. A
 * rename here degrades the CLI to "could not determine" — safe (never a false
 * green) but it stops reporting a real outage. Rename only in lockstep with
 * the CLI, and tell whoever owns it.
 */
const DependencySchema = z
  .object({
    name: z.literal("intelligence-service"),
    /**
     * `reachable` — the dependency answered the probe.
     * `unreachable` — we know its URL, the probe failed (timeout/network/5xx).
     * `unresolved` — resolution itself failed; we do not know which URL to
     *   probe. NOT the same as unreachable, and never reported as such.
     */
    state: z.enum(["reachable", "unreachable", "unresolved"]),
    /** Convenience mirror of `state === "reachable"`. */
    reachable: z.boolean(),
    /** Why it is not reachable. Absent when it is. */
    reason: z.string().optional(),
    /** Origin only (scheme://host:port) — path, query and userinfo stripped. */
    endpoint: z.string().optional(),
    /** Which IS row the resolution picked. */
    serviceId: z.string().optional(),
    /** HTTP status the probe got back, when it got one. */
    httpStatus: z.number().optional(),
    /** Round-trip time of the probe in ms. Absent when unresolved. */
    latencyMs: z.number().optional(),
  })
  .openapi("HealthDependency");

const HealthDependenciesSchema = z
  .object({
    /** "ok" when every dependency is reachable, "degraded" otherwise. */
    status: z.enum(["ok", "degraded"]),
    service: z.literal("hub-protocol"),
    checkedAt: z.string(),
    /** The resolution context used — the probe mirrors real request routing. */
    resolution: z.object({
      workspaceId: z.string().nullable(),
      capability: z.string(),
    }),
    dependencies: z.array(DependencySchema),
  })
  .openapi("HealthDependencies");

/**
 * Reduce a URL to its origin. Keeps the report useful for diagnosis (which
 * host are we actually talking to) without echoing a path or embedded
 * credentials. Returns a marker rather than throwing on an unparseable value.
 */
function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable-url>";
  }
}

/** Short, non-throwing description of a probe failure. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    // AbortController surfaces the timeout as an AbortError.
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return `probe timed out after ${PROBE_TIMEOUT_MS}ms`;
    }
    return err.message;
  }
  return String(err);
}

export function registerHealthDependenciesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/health/dependencies",
    tags: ["System"],
    summary: "Dependency reachability probe (readiness)",
    description:
      "Reports whether the pod's downstream dependencies are reachable — " +
      "currently the Intelligence Service. Separate from GET /health, which " +
      "is an unauthenticated liveness probe and deliberately performs no " +
      "network I/O. The IS URL is resolved through the SAME resolution real " +
      "requests use (capability-first → workspace → user → pod default → env " +
      "fallback), so the probe cannot check a URL requests never touch. " +
      "Always returns 200 with a reported state: an unreachable dependency " +
      "is data, not an error. `state` distinguishes `unreachable` (URL known, " +
      "probe failed) from `unresolved` (resolution itself failed).",
    request: {
      query: z.object({
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Resolve the IS as this workspace would — matches the routing a " +
              "capture from that workspace gets. Omit for pod-level resolution."
          ),
      }),
    },
    responses: {
      200: {
        description:
          "Dependency report. 200 even when a dependency is down — read `status`.",
        schema: HealthDependenciesSchema,
      },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden — hub-protocol.read required" },
    },
  });

  app.get("/health/dependencies", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const workspaceId = c.req.query("workspaceId") ?? undefined;
    const capability = "default" as const;

    const dependency = await probeIntelligenceService({ userId, workspaceId });

    return c.json({
      status: dependency.reachable ? ("ok" as const) : ("degraded" as const),
      service: "hub-protocol" as const,
      checkedAt: new Date().toISOString(),
      resolution: { workspaceId: workspaceId ?? null, capability },
      dependencies: [dependency],
    });
  });
}

type DependencyReport = z.infer<typeof DependencySchema>;

/**
 * Resolve the IS exactly as a real request would, then probe its `/health`.
 * Never throws — every failure becomes a reported state.
 */
async function probeIntelligenceService(ctx: {
  userId: string;
  workspaceId?: string;
}): Promise<DependencyReport> {
  let endpoint: string;
  let serviceId: string;
  try {
    const resolved = await resolveIntelligenceService({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      capability: "default",
    });
    endpoint = resolved.endpoint;
    serviceId = resolved.serviceId;
  } catch (err) {
    // Resolution itself failed — we do NOT know which URL requests would use,
    // so reporting "unreachable" would invent a fact. Say what actually broke.
    logger.warn(
      { err, userId: ctx.userId, workspaceId: ctx.workspaceId },
      "health/dependencies: intelligence-service resolution failed"
    );
    return {
      name: "intelligence-service",
      state: "unresolved",
      reachable: false,
      reason: `intelligence service resolution failed: ${describeError(err)}`,
    };
  }

  if (!endpoint) {
    return {
      name: "intelligence-service",
      state: "unresolved",
      reachable: false,
      serviceId,
      reason: "resolution returned no endpoint URL",
    };
  }

  const redacted = redactEndpoint(endpoint);
  const started = Date.now();
  try {
    // Probe the IS's own liveness door — the same origin `structure()` posts
    // to, so an unreachable origin here means an unreachable origin there.
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        name: "intelligence-service",
        state: "unreachable",
        reachable: false,
        endpoint: redacted,
        serviceId,
        httpStatus: response.status,
        latencyMs,
        reason: `health probe returned ${response.status} ${response.statusText}`,
      };
    }
    return {
      name: "intelligence-service",
      state: "reachable",
      reachable: true,
      endpoint: redacted,
      serviceId,
      httpStatus: response.status,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    logger.warn(
      { err, endpoint: redacted, serviceId },
      "health/dependencies: intelligence-service probe failed"
    );
    return {
      name: "intelligence-service",
      state: "unreachable",
      reachable: false,
      endpoint: redacted,
      serviceId,
      latencyMs,
      reason: describeError(err),
    };
  }
}
