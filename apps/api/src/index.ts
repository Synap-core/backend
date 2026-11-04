/**
 * Synap API Server
 *
 * Hono server with:
 * - tRPC API endpoints
 * - Ory Kratos routes (session-based authentication)
 * - Token Exchange endpoint
 * - pg-boss job queue (background jobs)
 */

// Load environment variables from .env
import "dotenv/config";

// Initialize OpenTelemetry tracing FIRST (before any other imports)
// This must be done before importing any libraries to ensure proper instrumentation
// TODO: Enable tracing for production observability — `tracing.ts` is not in
// the @synap-core/core barrel; add a `./tracing` export subpath first (relay-app
// derives its tsconfig paths from those exports: its map must follow).
// import { initializeTracing } from "@synap-core/core/tracing";
// initializeTracing();

import { Hono, type Context as HonoContext } from "hono";
import { HTTPException } from "hono/http-exception";

import { logger } from "hono/logger";
import { redactSecretPath } from "./middleware/redact-secret-path.js";
import { isUuid } from "@synap-core/types/property-render";
import { POD_FEATURES } from "@synap-core/types/device";
import { secureHeaders } from "hono/secure-headers";
import { getCookie } from "hono/cookie";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import {
  createLogger,
  config,
  isSynapError,
  toSynapError,
  validateConfig,
} from "@synap-core/core";
import {
  appRouter,
  createContext as createApiContext,
  hubProtocolRestApp,
  hubProtocolRouter,
  integrationsCapabilitiesApp,
  mcpHttpApp,
  oauthApp,
  podIdentityJwksApp,
  fileUploadApp,
  mediaTranscribeApp,
  externalSkillsApp,
  externalChatApp,
  chatStreamApp,
  captureProgressStreamApp,
  openaiCompatApp,
  webhooksInboundRouter,
  sanitizeErrorEgress,
  refuseGuestSession,
  podAccessOf,
  appSessionMiddleware,
} from "@synap/api";
import { serve } from "@hono/node-server";
import { parseProcessRole, stopBoss, stopLocalSyncDriver } from "@synap/jobs";
import crypto from "crypto";
import {
  rateLimitMiddleware,
  aiRateLimitMiddleware,
  requestSizeLimit,
  applicationConnectionStatusRateLimitMiddleware,
  handshakeRateLimitMiddleware,
  watchPodRateLimits,
} from "./middleware/security.js";
import { usageTelemetry } from "./middleware/usage-telemetry.js";
import { eventLoopWatch } from "./status/event-loop-watch.js";
import { configuredPodAdminBase } from "./pod-admin-config.js";
import { registerInviteBounce } from "./invite-bounce.js";
import { registerLinkCloudBounce } from "./link-cloud-bounce.js";
import {
  dispatchOpen,
  OPEN_CLIENT_PARAM,
  inferOpenTypeFromId,
  isSafeOpenId,
  isTypedOpenKind,
  normalizeOpenId,
  packageUpdateOpenTarget,
  podAdminBrowserUrl,
} from "./open-dispatch.js";
import { setupEventBroadcasting, skillRuntimeHealth } from "@synap/api";
import { configureLocalMode, safeTokenEqual } from "@synap/auth";
import { buildKratosProxyTargetUrl } from "./kratos-proxy-url.js";
import { trpcSessionGate } from "./trpc-session-gate.js";
import { trpcAiRateLimit } from "./trpc-ai-rate-limit.js";
import {
  markTrpcAnswer,
  TRPC_MAX_BATCH_SIZE,
  trpcEnvelope,
} from "@synap/api/trpc-refusal";
import { createRequire } from "node:module";
import {
  DEFAULT_POD_STATE_DIR,
  backupStatusBody,
  cachedDataHealth,
  healthStatusFor,
  readinessFor,
} from "./status/pod-data-status.js";
import { cachedAuthHealth } from "./status/pod-auth-status.js";
import { summarizeMigrationLedger } from "./status/migration-ledger.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Which part of the backend this process runs (SYNAP_PROCESS_ROLE: all · api
// · worker, plan P6; @synap/events process-role.ts). Read once, here: an
// invalid value stops the boot rather than starting a backend that serves or
// works nothing. LOCAL_MODE (the Electron pod) is one process by design.
const apiLogger = createLogger({ module: "api-server" });
const processRole = (() => {
  try {
    const role = parseProcessRole();
    if (role !== "all" && config.server.localMode) {
      throw new Error(
        `SYNAP_PROCESS_ROLE=${role} with LOCAL_MODE: a local pod runs as one process (all)`
      );
    }
    return role;
  } catch (err) {
    apiLogger.error({ err }, "Invalid process role — refusing to start");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();
apiLogger.info({ processRole }, "Process role");

// Setup event broadcasting to SSE clients. A worker holds no SSE connection:
// it relays each event to the API (utils/event-stream-relay.ts).
setupEventBroadcasting({
  stream: processRole === "worker" ? "relay" : "local",
});
apiLogger.info("Event broadcasting initialized");

// ── Running-build version (for /status/release) ─────────────────────────────
// Reads the ACTUAL @synap/api package version off disk at runtime — this is the
// router code the pod is executing right now, so a stale/partial deploy shows a
// version that lags the repo. Resolved once and memoized. The exports map on
// @synap/api does NOT expose ./package.json, so we resolve the package main and
// walk up to the nearest package.json whose name matches.
const nodeRequire = createRequire(import.meta.url);
let cachedApiVersion: string | null | undefined;
function getRunningApiVersion(): string | null {
  if (cachedApiVersion !== undefined) return cachedApiVersion;
  try {
    let dir = dirname(nodeRequire.resolve("@synap/api"));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "@synap/api") {
          cachedApiVersion = pkg.version ?? null;
          return cachedApiVersion;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to null
  }
  cachedApiVersion = null;
  return cachedApiVersion;
}

// Validate configuration at startup
try {
  // Validate PostgreSQL database config
  validateConfig("postgres");
  apiLogger.info("PostgreSQL configuration validated");

  // Validate storage config only if explicitly set to R2
  // If R2 credentials are missing, provider will auto-switch to MinIO
  if (config.storage.provider === "r2") {
    // Only validate if we actually have R2 credentials
    // If not, the provider should have been auto-switched to MinIO
    if (
      config.storage.r2AccountId &&
      config.storage.r2AccessKeyId &&
      config.storage.r2SecretAccessKey
    ) {
      validateConfig("r2");
      apiLogger.info("R2 storage configuration validated");
    } else {
      // This shouldn't happen if auto-detection works, but log a warning
      apiLogger.warn(
        "R2 provider selected but credentials missing - should auto-switch to MinIO"
      );
    }
  } else {
    apiLogger.info(
      { provider: config.storage.provider },
      "Storage provider configured"
    );
  }

  // Validate AI config in production
  if (config.server.nodeEnv === "production") {
    validateConfig("ai");
    apiLogger.info("AI configuration validated");
  }

  // Validate Intelligence Hub config (warns in dev, throws in production if missing)
  validateConfig("intelligenceHub");
  apiLogger.info("Intelligence Hub configuration validated");

  // LOCAL_MODE mutual-exclusion: LOCAL_MODE=true and KRATOS_PUBLIC_URL must
  // not be set together — that would mean the operator forgot to remove Ory
  // config from the env, which could silently leave the auth path ambiguous.
  if (config.server.localMode && config.auth.kratosPublicUrl) {
    apiLogger.error(
      "LOCAL_MODE=true and KRATOS_PUBLIC_URL are both set. " +
        "These are mutually exclusive: remove KRATOS_PUBLIC_URL (and HYDRA_PUBLIC_URL) " +
        "when running in local mode."
    );
    process.exit(1);
  }

  // LOCAL_MODE requires LOCAL_AUTH_TOKEN — the Electron host generates and
  // passes this token; without it the pod cannot authenticate any request.
  if (config.server.localMode && !config.server.localAuthToken) {
    apiLogger.error(
      "LOCAL_MODE=true but LOCAL_AUTH_TOKEN is not set. " +
        "The Electron host must generate a token and pass it as LOCAL_AUTH_TOKEN."
    );
    process.exit(1);
  }

  // Validate Ory Stack (Kratos + Hydra) auth config.
  // In LOCAL_MODE this is a no-op (validateConfig branches on localMode).
  validateConfig("ory");
  if (config.server.localMode) {
    apiLogger.info("Local mode: Ory Stack auth bypassed (fixed-identity)");
  } else {
    apiLogger.info("Ory Stack configuration validated");
  }
  // Required-secret validation — pre-`serve()` so a missing secret fails BEFORE
  // the health port opens (moved out of the post-listen startup hooks, which
  // exited AFTER listening → orchestrator saw a healthy-then-crash flap). Exits
  // non-zero on any missing secret, alongside the other fatal config checks.
  validateCriticalSecrets();
} catch (error) {
  apiLogger.error({ err: error }, "Configuration validation failed");
  apiLogger.error(
    {
      error: error instanceof Error ? error.message : String(error),
    },
    "Please check your environment variables and configuration"
  );
  process.exit(1);
}

// Initialise local-mode state from Zod-validated config values.
// All auth paths (ory-middleware, ory-kratos, /api/session) read ONLY the
// module-level state set here — no raw process.env.LOCAL_MODE reads in auth paths.
configureLocalMode(config.server.localMode, config.server.localAuthToken);

// Initialize Hono app
const app = new Hono();

// CORS middleware — first-party allowlist plus owner-approved applications.
// The middleware itself lives in `pod-edge-cors.ts` (extracted verbatim so the
// transport guards drive the real chain); its full rationale is there. The
// credentialless public doors get their own policy, mounted OUTSIDE it
// (`public-door-transport.ts`).
import { hasConfiguredOrigins, isAllowedOrigin } from "./cors-origin.js";
import { mountAdminEventStream } from "./admin-event-stream.js";
import {
  httpCacheHeadersMiddleware,
  podEdgeCorsMiddleware,
} from "./pod-edge-cors.js";
import { publicDoorTransport } from "./public-door-transport.js";

if (!hasConfiguredOrigins() && process.env.NODE_ENV === "production") {
  apiLogger.warn(
    "[SECURITY] Neither SYNAP_BASE_DOMAIN nor ALLOWED_ORIGINS is set — all cross-origin browser requests will be denied. Set SYNAP_BASE_DOMAIN to your pod's base domain (e.g. example.com) so first-party surfaces (studio., app., …) can reach the pod."
  );
}

// Every /trpc answer is a tRPC response, the refusals below included (the
// CORS 403, the size limit's 413, the rate limit's 429, the session gate's
// 401): OUTERMOST on /trpc, so it sees what every middleware answered. See
// packages/api middleware/trpc-refusal.ts.
app.use("/trpc/*", trpcEnvelope(appRouter));

// Credentialless public doors FIRST (outermost): their transport policy must
// never be seen, widened or 403'd by the credentialed CORS below.
app.use("*", publicDoorTransport);
app.use("*", podEdgeCorsMiddleware);

// Security Middleware
app.use("*", requestSizeLimit); // Max 10MB requests
// Mounted on "*" BEFORE every route, so tRPC and the backend's own
// /.ory/kratos/public/* proxy (pod-admin's whoami) are keyed alike.
// Usage telemetry (0364) wraps the limiter so it counts the limiter's own
// 429s too; a separate middleware, the limiter itself is untouched.
app.use("*", usageTelemetry.middleware);
app.use("*", rateLimitMiddleware); // multi-class; Bearer, session or IP keyed
app.use("*", secureHeaders()); // Hono built-in security headers

// 5xx egress sanitizer — registered as the OUTERMOST response-shaping
// middleware so it observes every server-fault body, whether the handler threw
// (converted by app.onError below) or returned `c.json({ error: <driver
// message> }, 500)` directly. See middleware/error-egress.ts for the full
// rationale and the deliberate exemptions (dev, tRPC, non-JSON).
app.use(
  "*",
  sanitizeErrorEgress({
    isDev: config.server.nodeEnv === "development",
    log: apiLogger,
  })
);
apiLogger.info("Security middleware registered");

// HTTP Cache Headers — see pod-edge-cors.ts (extracted verbatim, Sites W3).
app.use("*", httpCacheHeadersMiddleware);

// Logging — the path is redacted first: two routes carry their capability IN
// the path (calendar ICS feed, agent setup hand-off), and a subscribed calendar
// client would otherwise write its permanent token to stdout every 5 minutes.
app.use(
  "*",
  logger((message, ...rest) =>
    console.log(redactSecretPath(message), ...rest.map(String))
  )
);

// Data check for /health — see status/pod-data-status.ts for why a data alarm
// is a body field ("degraded" + `data`) and never a non-200.
const podDataHealth = cachedDataHealth({
  stateDir: process.env.SYNAP_POD_STATE_DIR || DEFAULT_POD_STATE_DIR,
  hasUsers: async () => {
    const { sql } = await import("@synap/database");
    const rows = await sql<Array<{ present: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM users) AS present
    `;
    return Boolean(rows[0]?.present);
  },
});

// Sign-in readiness for /health — see status/pod-auth-status.ts (body field, never a non-200).
const podAuthHealth = cachedAuthHealth({
  kratosPublicUrl:
    process.env.LOCAL_MODE === "true"
      ? null
      : process.env.KRATOS_PUBLIC_URL || "http://localhost:4433",
});

// Health check (public, no auth). HTTP 200 whenever the process serves.
app.get("/health", async (c) => {
  const [data, authHealth] = await Promise.all([
    podDataHealth(),
    podAuthHealth(),
  ]);
  return c.json({
    status: healthStatusFor(data, authHealth),
    // ready · starting (boot hooks still running) · unknown (data check could
    // not answer). Body-only, like `data`: see readinessFor.
    readiness: readinessFor(data, startupHooksState()),
    timestamp: new Date().toISOString(),
    version: "0.2.0-saas",
    // Published `@synap-core/api-types` version this pod's router was built
    // against. Clients compare its major via `assertApiTypesCompatible()` to
    // detect stale pinned types.
    //
    // It is a LITERAL, and it only stays honest when the version bump goes
    // through `packages/api-types/scripts/check-and-bump.mjs` (:166-170 is the
    // sole writer of this line). Bump package.json by hand — as the 1.22.0
    // regen did — and this silently keeps reporting the old version while the
    // published package has moved on. It read 1.21.1 against a 1.22.0 package
    // until this fix, so every client's compatibility check was answering
    // against a version that no longer existed.
    //
    // DO NOT gate a deploy check on this field: it is not derived from the
    // running build, so it looks identical whether or not a deploy landed.
    apiTypesVersion: "1.34.1",
    mode: "multi-user",
    auth: "ory-stack",
    // Feature marks a client reads before it uses a newer door (0395:
    // "agent-seats"). Contract: @synap-core/types/device POD_FEATURES.
    features: POD_FEATURES,
    // Git SHA the running image was built from (see deploy/Dockerfile ARG
    // GIT_SHA -> ENV SYNAP_GIT_SHA, already surfaced on /status/release as
    // `buildStamp`). Repeated here so a single `curl /health` answers "is this
    // build actually deployed?" without a second call. "unknown" when unset.
    buildSha: process.env.SYNAP_GIT_SHA || "unknown",
    // "empty" = this pod had users (deploy/state/postgres-initialized) and
    // now has none: top-level status reads "degraded".
    data,
    // Kratos /health/ready: "not_ready" also reads "degraded" (the CP health
    // check counts it as a failed check). `auth` above stays the stack name.
    authHealth,
    // Where code skills run (intelligence-service, or the pod's runner pool)
    // and, for the pool, whether it can: `unavailable` + `reason` when a
    // runner cannot start. Body-only, like `data`.
    skillRuntime: skillRuntimeHealth(),
    // Event-loop delay and utilization over the rolling window, and how many
    // stalls were logged (status/event-loop-watch.ts). In memory, no I/O;
    // numbers only: the requests a stall named are on /status/release's
    // details and in the `event loop blocked` log line.
    eventLoop: eventLoopWatch.snapshot(),
  });
});

// GET /status/backup — backup metadata only (no secrets, no row counts),
// public like /status/release. Rule: readBackupStatus (@synap/database).
app.get("/status/backup", async (c) =>
  c.json(
    await backupStatusBody(async () => {
      const { readBackupStatus } = await import("@synap/database");
      return readBackupStatus();
    })
  )
);

// The Synap mark at /favicon.ico, /favicon.svg and /icon.svg: what an MCP
// client or a favicon service draws for this pod's connector (brand-icons.ts).
app.route("/", brandIconsApp);

// Root (direct :4000 / dev without Caddy): not the admin SPA — that lives at /admin/
app.get("/", (c) => {
  return c.json({
    service: "Synap Data Pod API",
    adminConsole: "/admin/",
    health: "/health",
    docs: "https://doc.synap.live",
  });
});

// Public API discovery index. Points at the Hub Protocol surfaces so an
// operator (or agent) can orient before holding a valid bearer. Exact `GET /api`
// — Hono matches it before the deeper `/api/hub` sub-app mounts below; no
// hub-auth middleware runs here (that lives inside hubProtocolRestApp only).
app.get("/api", (c) =>
  c.json({
    service: "Synap Data Pod API",
    hub: {
      base: "/api/hub",
      openapi: "/api/hub/openapi.json", // public, full route manifest
      manifest: "/api/hub/manifest", // AI-agent capability manifest (public)
      health: "/api/hub/health",
      authStatus: "/api/hub/auth/status", // Bearer-gated introspection
    },
    aliases: ["/api/hub-protocol"],
    version: "0.2.0-saas",
  })
);

// Prometheus metrics endpoint (public, no auth)
app.get("/metrics", async (c) => {
  const { getMetrics } = await import("@synap-core/core");
  const metrics = await getMetrics();
  return c.text(metrics, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// Ontology-conversions boot state — set by the conversion boot gate below on
// EVERY completed pass (not only a degraded one — a clean boot must stamp
// `checkedAt` and `pending` too). `degraded` = an ADVISORY op failed at boot
// but the pod kept serving (fatal ops still exit(1)); `pending` = ops deferred
// for a deliberate operator run. Surfaced on /status/release so a
// running-but-un-migrated pod is VISIBLE, not invisible. Projection lives in
// startup/boot-status.ts (shared with its test).
import {
  BOOT_CONVERSION_OPTIONS,
  UNCHECKED_CONVERSIONS_STATE,
  conversionsBootStateFromSummary,
  conversionsStatusSection,
  systemProfilesStatusSection,
  type ConversionsBootState,
} from "./startup/boot-status.js";
let conversionsBootState: ConversionsBootState = UNCHECKED_CONVERSIONS_STATE;

// ── Deploy verification ─────────────────────────────────────────────────────
// GET /status/release answers "is the latest actually deployed, and did the
// migration apply?" in one call. Every lookup is wrapped so a missing table or
// failed check degrades to null + a note — it never 500s. Kept OUT of /health
// so the liveness probe stays cheap and its api-types compat literal is
// untouched.
//
// Public: `status`, `timestamp`, `version`, `buildStamp` (the CP's release
// door reads `buildStamp`). The DETAILS (migration ledger, schema drift,
// pending conversions, system-profile seeding) are pod internals: only the
// diagnostics reader gets them (`podDiagnosticsReader`: the pod's Control
// Plane, a pod admin's session, or an in-container loopback call, which is how
// the update engine reads this route before `verify-deploy.sh`). Audit
// pod-doors F4.
app.get("/status/release", async (c) => {
  // version — the running @synap/api build (off disk, not a literal)
  const version = getRunningApiVersion();

  // buildStamp — the git commit the running image was built from, stamped in
  // at image-build time via `docker build --build-arg GIT_SHA=$(git rev-parse HEAD)`
  // (deploy/Dockerfile ARG GIT_SHA -> ENV SYNAP_GIT_SHA). null when the image
  // was built/pulled without that arg (older images, registry pulls that
  // predate this change) — reported as null rather than fabricated.
  const buildStamp: string | null = process.env.SYNAP_GIT_SHA || null;

  // A FAILED check of the caller (the CP link or the session could not be
  // read) serves the public answer, saying so: never the details, and never a
  // 500 for the part that needs no database.
  let reader: "details" | "public" | "denied" | "unchecked";
  try {
    reader = await podDiagnosticsReader(c);
  } catch (err) {
    apiLogger.warn({ err }, "/status/release: caller check failed");
    reader = "unchecked";
  }
  if (reader === "denied") {
    return c.json({ error: "Issuer is not approved for this Pod" }, 401);
  }
  if (reader !== "details") {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version,
      buildStamp,
      ...(reader === "unchecked"
        ? { note: "details unavailable: the caller could not be checked" }
        : {}),
    });
  }

  // migrations — the hand-written migration ledger (_migrations, public schema)
  let migrations: {
    lastApplied: string | null;
    lastAppliedAt: string | null;
    count: number;
    note?: string;
  } = { lastApplied: null, lastAppliedAt: null, count: 0 };
  try {
    const { sql } = await import("@synap/database");
    const rows = await sql<Array<{ filename: string; applied_at: string }>>`
      SELECT filename, applied_at FROM _migrations
    `;
    migrations = summarizeMigrationLedger(rows);
  } catch (err) {
    migrations = {
      lastApplied: null,
      lastAppliedAt: null,
      count: 0,
      note: `Could not read _migrations: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // schemaCoherence — reuse the pod-startup drift validator (one query)
  let schemaCoherence: {
    ok: boolean | null;
    drift: Array<{ table: string; column: string; addedBy: string }>;
    checked?: number;
    note?: string;
  } = { ok: null, drift: [] };
  try {
    const { checkSchemaCoherence } = await import("@synap/database");
    const result = await checkSchemaCoherence();
    schemaCoherence = {
      ok: result.ok,
      drift: result.missing.map((m) => ({
        table: m.table,
        column: m.column,
        addedBy: m.addedBy,
      })),
      checked: result.checked,
    };
  } catch (err) {
    schemaCoherence = {
      ok: null,
      drift: [],
      note: `Coherence check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version,
    migrations,
    schemaCoherence,
    buildStamp,
    // conversions — degraded=true when an ADVISORY conversion op failed to
    // apply at boot yet the pod kept serving (fatal ops exit(1) instead, so a
    // fatal failure never reaches this route). `pending` lists ops deferred
    // for an operator run (destructive-tail / defer-at-boot); null + a null
    // checkedAt mean the boot pass has not run (e.g. SYNAP_SKIP_CONVERSIONS).
    conversions: conversionsStatusSection(conversionsBootState),
    // systemProfiles — the boot seeder's result. status:"error" means schema
    // upgrades did not apply; null until the post-listen startup hook reports.
    systemProfiles: systemProfilesStatusSection(),
    // eventLoop — /health's numbers plus the requests the last stall named
    // (method, redacted path, key id): who blocked the loop, after the fact.
    eventLoop: eventLoopWatch.snapshot({ named: true }),
  });
});

// ─── Legacy /admin/connect → pod-admin/connect redirect ───────────────
//
// The legacy admin-ui SPA at `pod.<root>/admin/*` was retired in the
// 2026-05 auth refactor; the connect surface moved to pod-admin's
// native `/connect` page on the `pod-admin.<root>` subdomain.
//
// In-the-wild Synap CLI / Raycast / agent installs still build URLs
// against `${podUrl}/admin/connect?integration=…&redirect_uri=…`. We
// 302 those to the new home so existing installs keep working without
// a CLI/Raycast upgrade. Future releases of those clients should target
// `pod-admin.<root>/connect` directly via
// `buildIntegrationConnectUrl()` in `@synap-core/external-connect-client`.
app.get("/admin/connect", (c) => {
  const url = new URL(c.req.url);
  const admin = configuredPodAdminBase();
  if (!admin.ok) {
    return c.json(
      {
        error: "Pod Console is not configured",
        code: admin.code,
        remediation: "configure_pod_admin_url",
      },
      503
    );
  }
  const target = new URL("/connect", admin.base);
  target.search = url.search;
  return c.redirect(target.toString(), 302);
});

// ─── /invite/:token → this pod's console invite page ─────────────────────
// The link an own-domain pod's invite email carries (`invite-bounce.ts`).
registerInviteBounce(app);

// ─── /admin/link-cloud → this pod's console "Link Synap Cloud" page ──────
// Where the CP's claim-access hop lands (`link-cloud-bounce.ts`).
registerLinkCloudBounce(app);

// ── Deep-link bounce (public, no auth) ──────────────────────────────────────
// An https URL — clickable anywhere (Discord, email, chat). Humans hitting
// proposal | entity | view | automation | session (and an untyped uuid) 302
// to pod-admin when it's configured; unfurl bots (and every other type) get a
// tiny page that redirects to `synap://` so Discord/etc. never scrape bodies. Discord will NOT linkify a raw
// `synap://` URL. The app's deep-link handler (`useDeepLinkHandler.ts`)
// understands `synap://open/<type>/<id>` for
// proposal | entity | view | document | cell | channel | session | project |
// workspace. No auth here: this only forwards a scheme; the target surface is
// access-gated inside the app. The typed ALLOWED set below MUST stay in
// lock-step with the bare-id probe (and with kinds the bounce page emits).
// Renders the tiny https page that immediately redirects to the given
// `synap://` deep link. `deep` (and optional `browserUrl`) contain only
// validated/known-safe chars, so they interpolate into href/JS without
// escaping concerns. If the app isn't installed the redirect is a no-op, so
// after a short delay we reveal a fallback block (with a manual retry link)
// rather than stranding the user on "Opening…" forever.
function renderDeepLinkPage(deep: string, browserUrl?: string): string {
  const browserLink = browserUrl
    ? `<p><a href="${browserUrl}">View in browser</a></p>`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Opening in Synap…</title>` +
    `<script>location.replace(${JSON.stringify(deep)});` +
    `setTimeout(function(){var f=document.getElementById('fallback');if(f)f.style.display='block';},1500);</script>` +
    `<style>html,body{height:100%}body{margin:0;font-family:system-ui,-apple-system,sans-serif;` +
    `background:#0b0b0c;color:#e9e9ec;display:flex;align-items:center;justify-content:center}` +
    `a{color:#10b981}main{text-align:center;max-width:24rem;padding:2rem}` +
    `h1{font-size:1rem;font-weight:500;margin:0}` +
    `.spinner{width:1.5rem;height:1.5rem;margin:0 auto 1rem;border-radius:50%;` +
    `border:2px solid #2a2a2e;border-top-color:#10b981;animation:spin .8s linear infinite}` +
    `#fallback{display:none;margin-top:1.5rem;font-size:.875rem;color:#a1a1aa}` +
    `#fallback a{text-decoration:underline}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `@media (prefers-reduced-motion:reduce){.spinner{animation:none}}</style>` +
    `</head><body><main>` +
    `<div class="spinner" aria-hidden="true"></div>` +
    `<h1 role="status" aria-live="polite">Opening in Synap…</h1>` +
    `<div id="fallback"><p>Didn't open? Make sure the Synap app is installed.</p>` +
    `<p><a href="${deep}">Open in Synap</a></p>${browserLink}</div>` +
    `</main></body></html>`
  );
}

// Proposal 302s to pod-admin first (web is the review surface, bots included).
// The hosted kinds (`WEB_HOSTED_OPEN_KINDS`) have a web host for humans; unfurl
// bots still bounce so Discord/etc. never scrape bodies. Other types bounce.
// Falls through to bounce if pod-admin isn't configured (graceful).
function applyOpenDispatch(
  c: HonoContext,
  type: string | undefined,
  id: string
) {
  const admin = configuredPodAdminBase();
  const adminBase = admin.ok ? admin.base.toString() : null;
  const result = dispatchOpen({
    type,
    id,
    userAgent: c.req.header("user-agent"),
    adminBase,
    // The device discriminator is a link-BUILD-time query param, not a UA
    // sniff — see OPEN_CLIENT_PARAM in open-dispatch.ts for why.
    client: c.req.query(OPEN_CLIENT_PARAM),
    // `?view=` addresses a READING of the object (a session's Intake Room).
    // `dispatchOpen` allowlists it; an unrecognised value is dropped there.
    view: c.req.query("view"),
    // `?flowType=` addresses a RUN (`{flowType, id}`); kept only on a run link.
    flowType: c.req.query("flowType"),
  });
  // Same URL 302s or 200s by User-Agent — never let a CDN cache the bot bounce
  // for a human (or the reverse). `?client=` is part of the URL, so it varies
  // the cache key on its own and needs no Vary entry.
  c.header("Vary", "User-Agent");
  c.header("Cache-Control", "private, no-store");
  if (result.action === "redirect") {
    return c.redirect(result.url, 302);
  }
  // The "View in browser" escape when `synap://` did nothing — a phone without
  // relay, a session Intake Room link without the app. `podAdminBrowserUrl`
  // names pod-admin's page for the kind, or none.
  const browserUrl = podAdminBrowserUrl(
    type,
    id,
    adminBase,
    c.req.query("flowType")
  );
  return c.html(renderDeepLinkPage(result.deep, browserUrl));
}

// A template update's link (`/open/update/<slug>`, `/open/updates`): the page
// lives on pod-admin only, so a pod without it has nowhere to send the reader.
function applyPackageUpdateOpen(
  c: HonoContext,
  type: string | undefined,
  id: string
) {
  const admin = configuredPodAdminBase();
  c.header("Cache-Control", "private, no-store");
  if (!admin.ok) return c.text("This pod has no admin website", 404);
  const target = packageUpdateOpenTarget(type, id, admin.base.toString());
  return target ? c.redirect(target, 302) : c.text("Invalid deep link", 400);
}

app.get("/open/:type/:id", (c) => {
  // `project` / `workspace` are lens targets (not rows the app "opens" as a
  // surface) — the browser deep-link handler switches the active lens and lands
  // on that lens's home dashboard. Backs clickable statusline links (synap-cli).
  const type = c.req.param("type").trim().toLowerCase();
  const id = normalizeOpenId(c.req.param("id"));
  if (type === "update") return applyPackageUpdateOpen(c, type, id);
  // id is a UUID or a cell typeKey — allow only url/HTML-safe chars so it can be
  // interpolated into href/JS without escaping concerns.
  if (!isTypedOpenKind(type) || !isSafeOpenId(id)) {
    return c.text("Invalid deep link", 400);
  }
  // Keep this typed route in lock-step with bare-id `/open/:id`. No producer
  // builds this typed form for proposals today (canonical `deep-links.ts`
  // emits the bare-id shape).
  return applyOpenDispatch(c, type, id);
});

// ── Canonical bare-id deep-link bounce (public, no auth) ─────────────────────
// The one link shape every create/propose response emits: `${PUBLIC_URL}/open/
// <id>` (see packages/api/src/utils/deep-links.ts).
//
// THIS ROUTE OWNS NO TYPE LIST. It is public and unauthenticated, so it cannot
// user-floor a lookup — the canonical, USER-floored id→kind resolver is
// `GET /api/hub/resolve/:id` (`resolveObjectKind`), which the signed-in app
// calls for a kind-less `synap://open/<id>`. This route probes ONLY the kinds
// that change the HTTP ANSWER itself:
//   • proposal      → 302 to the pod-admin review page (humans AND bots);
//   • entity / view → 302 to the pod-admin web host (humans only).
// Every other id — skill, session, playbook, automation, channel, document,
// project, … — is UNTYPED here. A human browser 302s to pod-admin's resolver
// page (`/open/<id>`), which asks `diagnose.resolveOpen` WITH the reader's
// cookie and routes to the typed page (hosted, or a named "open in app"
// card); a bot or a `?client=mobile` link bounces as `synap://open/<id>` and
// the app resolves it. A private probe list here used to decide those kinds
// and fell behind the route table (a skill / session / playbook id bounced
// typeless and landed nowhere) — the user-floored resolver is the only list.
//
// `projects` is still read, but only as a GUARD: migration 0151 copied projects
// into the first-class `projects` table while preserving ids and left the
// pre-0151 `entities` row live under the same id, so an entity probe alone
// would 302 a project id onto the stale entity copy. A project id bounces
// untyped like every other non-web kind.
//
// A probe that FAILS is not a miss: it is logged and the id goes on UNTYPED
// (never a typed 302 decided on a guess), so an authenticated resolver —
// pod-admin's page or the app's — gives the real answer, error included.
app.get("/open/:id", async (c) => {
  const id = normalizeOpenId(c.req.param("id"));
  if (!isSafeOpenId(id)) {
    return c.text("Invalid deep link", 400);
  }
  if (id === "updates") return applyPackageUpdateOpen(c, undefined, id);
  const inferred = inferOpenTypeFromId(id);
  if (inferred) {
    return applyOpenDispatch(c, inferred, id);
  }
  // Keywords such as `proposals` are not UUIDs. Bounce without probing —
  // a uuid `eq` would throw 22P02.
  if (!isUuid(id)) {
    return applyOpenDispatch(c, undefined, id);
  }

  let type: "proposal" | "entity" | "view" | undefined;
  try {
    const { getDb, eq, and, isNull } = await import("@synap/database");
    const { proposals, projects, entities, views } =
      await import("@synap/database/schema");
    const database = await getDb();
    const hit = async (query: Promise<unknown[]>) => (await query).length > 0;

    if (
      await hit(
        database
          .select({ id: proposals.id })
          .from(proposals)
          .where(eq(proposals.id, id))
          .limit(1)
      )
    ) {
      type = "proposal";
    } else if (
      // The 0151 guard above: a project id must never reach the entity probe.
      !(await hit(
        database
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1)
      ))
    ) {
      if (
        await hit(
          database
            .select({ id: entities.id })
            .from(entities)
            .where(and(eq(entities.id, id), isNull(entities.deletedAt)))
            .limit(1)
        )
      ) {
        type = "entity";
      } else if (
        await hit(
          database
            .select({ id: views.id })
            .from(views)
            .where(eq(views.id, id))
            .limit(1)
        )
      ) {
        type = "view";
      }
    }
  } catch (err) {
    apiLogger.error(
      { err, id },
      "/open bare-id web probe failed; bouncing untyped"
    );
    type = undefined;
  }

  return applyOpenDispatch(c, type, id);
});

// Ory Kratos routes
// Kratos handles its own routes via public API
// We proxy the necessary endpoints for browser-based flows
// This matches Caddy routing in production: /.ory/kratos/public/* -> Kratos
const kratosPublicUrl =
  process.env.KRATOS_PUBLIC_URL || "http://localhost:4433";

// Proxy function for Kratos requests
const proxyKratosRequest = async (c: HonoContext, kratosPath: string) => {
  try {
    // Forward request to Kratos public API
    const targetUrl = buildKratosProxyTargetUrl(
      kratosPublicUrl,
      kratosPath,
      c.req.url
    );

    // Prepare headers - forward cookies and other important headers
    const headers: Record<string, string> = {
      Cookie: c.req.header("cookie") || "",
    };

    // Forward content-type if present
    const contentType = c.req.header("content-type");
    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    // Forward Accept header — critical for Kratos to return JSON for API flows
    // Without this, some Kratos versions may default to browser-flow behavior
    const accept = c.req.header("accept");
    if (accept) {
      headers["Accept"] = accept;
    }

    // Forward X-Session-Token if present (for API-flow token auth)
    const sessionToken = c.req.header("x-session-token");
    if (sessionToken) {
      headers["X-Session-Token"] = sessionToken;
    }

    // Get request body for POST/PUT/PATCH
    let body: string | undefined;
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      const contentType = c.req.header("content-type");
      if (contentType?.includes("application/json")) {
        body = JSON.stringify(await c.req.json());
      } else {
        body = await c.req.text();
      }
    }

    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body,
      redirect: "manual",
    });

    // Build a Headers object. Set-Cookie needs special handling because
    // Kratos sets two cookies per flow (the flow cookie + csrf_token cookie),
    // and iterating headers naively combines them into one comma-joined line
    // that browsers cannot parse — which kills CSRF and every subsequent POST
    // fails with 400.
    const outHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      outHeaders.set(key, value);
    });
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const cookie of setCookies) outHeaders.append("set-cookie", cookie);

    return c.newResponse(response.body, {
      status: response.status as 200,
      headers: outHeaders,
    });
  } catch (error) {
    apiLogger.error(
      { err: error, path: kratosPath },
      "Error proxying Kratos request"
    );
    return c.json({ error: "Internal server error" }, 500);
  }
};

// Route: /.ory/kratos/public/* (matches Caddy handle_path routing)
// Caddy strips the /.ory/kratos/public prefix before forwarding to backend,
// so Kratos internally sees /self-service/... paths directly.
app.all("/.ory/kratos/public/*", async (c) => {
  if (config.server.localMode) {
    return c.json(
      { error: "Kratos routes are not available in local mode" },
      404
    );
  }
  const kratosPath = c.req.path.replace("/.ory/kratos/public", "");
  return proxyKratosRequest(c, kratosPath);
});

// Legacy route: /self-service/* (for backward compatibility)
app.all("/self-service/*", async (c) => {
  if (config.server.localMode) {
    return c.json(
      { error: "Kratos routes are not available in local mode" },
      404
    );
  }
  const kratosPath = c.req.path.replace("/self-service", "");
  return proxyKratosRequest(c, kratosPath);
});

// The canonical router receives the same rate limit before it is mounted
// farther below at `/api/federation`.
app.use("/api/federation/bootstrap", handshakeRateLimitMiddleware);
app.use("/api/federation/application-connections/requests/*", (c, next) => {
  if (c.req.path.endsWith("/status")) {
    return applicationConnectionStatusRateLimitMiddleware(c, next);
  }
  return handshakeRateLimitMiddleware(c, next);
});

// Session check endpoint — used by the web landing page (synap.dev) to determine
// if the user already has a valid Pod session after a previous federated
// exchange, so it does not need to create another session on every page load.
//
// Auth: ory_kratos_session cookie (set by the native or federated login flow).
// Returns 200 + session data if valid, 401 if missing or expired. `podAccess`
// ("member" | "guest" | "none", `access/pod-access.ts`) says whether the
// signed-in person is inside this pod at all: a client shows "No access to
// this pod" for "none". A failed access read is a 5xx, never a guessed answer.
app.get("/api/session", async (c) => {
  // LOCAL MODE: validate the bearer/x-local-token and return the fixed identity.
  // Only bearer + x-local-token are accepted — ory_kratos_session cookie is
  // NOT a valid LOCAL_MODE token channel.
  if (config.server.localMode) {
    const authHeader = c.req.header("Authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    const incomingToken = bearerToken || c.req.header("x-local-token") || "";

    if (
      !incomingToken ||
      !config.server.localAuthToken ||
      !safeTokenEqual(incomingToken, config.server.localAuthToken)
    ) {
      return c.json({ authenticated: false }, 401);
    }

    const { buildLocalApiSession } = await import("@synap/auth");
    const local = buildLocalApiSession();
    return c.json({
      ...local,
      podAccess: await podAccessOf(local.session.identity.id, c.req.raw),
    });
  }

  const sessionToken = getCookie(c, "ory_kratos_session");
  if (!sessionToken) {
    return c.json({ authenticated: false }, 401);
  }

  type WhoAmI = { identity?: { id?: string } };
  let session: WhoAmI;
  try {
    const resp = await fetch(`${kratosPublicUrl}/sessions/whoami`, {
      headers: {
        Cookie: `ory_kratos_session=${sessionToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      return c.json({ authenticated: false }, 401);
    }

    session = (await resp.json()) as WhoAmI;
  } catch (err) {
    apiLogger.error({ err }, "Session check failed");
    return c.json({ authenticated: false }, 401);
  }
  const identityId = session.identity?.id;
  if (!identityId) return c.json({ authenticated: false }, 401);
  return c.json({
    authenticated: true,
    session,
    podAccess: await podAccessOf(identityId, c.req.raw),
  });
});

if (config.server.localMode) {
  apiLogger.info(
    "Local mode: Ory Kratos routes respond 404 at /.ory/kratos/public/* and /self-service/*"
  );
} else {
  apiLogger.info(
    "Ory Kratos routes enabled at /.ory/kratos/public/* and /self-service/*"
  );
}

// Raw pod-wide event fanout (admin dashboard) — pod-admin only; see
// admin-event-stream.ts.
mountAdminEventStream(app);

// tRPC routes — session auth on every call except the public procedures
// (health.*, setup.*, invite preview/accept). See trpc-session-gate.ts. The
// session is a Kratos one or a Synap app's device token, and no other bearer
// (packages/api middleware/app-session.ts).
app.use("/trpc/*", trpcSessionGate(appSessionMiddleware()));

// WebSocket ticket minting (see ws-auth.ts for the CSWSH rationale). The browser
// exchanges its authenticated session for a short-lived, single-use ticket, then
// opens terminal WebSockets with `?ticket=`.
import { issueWsTicket } from "./ws-auth.js";

// The /api/ws-ticket mint endpoint reuses the global first-party origin policy
// (cors-origin.ts): a cross-origin page cannot mint a ticket from an untrusted
// origin, even though the request carries the session cookie.
app.post(
  "/api/ws-ticket",
  appSessionMiddleware(),
  refuseGuestSession,
  async (c) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    // `app` is an untyped Hono instance, so the context Variables map isn't known
    // to TS — but appSessionMiddleware (which runs before this handler) sets `userId` to
    // the authenticated identity id (string). Read it with an explicit type.
    const userId = c.get("userId" as never) as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    return c.json(issueWsTicket(userId));
  }
);

// AI Providers — public model discovery for the synap CLI (keys never returned)
import { providersRouter } from "./routers/providers.js";
app.route("/api/hub/providers", providersRouter);

// Automations schema — static reference document for trigger types, node types, CLI flags
import { automationsSchemaRouter } from "./routers/automations-schema.js";
app.route("/api/hub/automations/schema", automationsSchemaRouter);

// Connectors schema — static reference document for connector providers, CLI commands, REST endpoints
import { connectorsSchemaRouter } from "./routers/connectors-schema.js";
app.route("/api/hub/connectors/schema", connectorsSchemaRouter);

// Admin routes (public API for invitations)
import { adminRouter } from "./routers/admin.js";
app.route("/api/admin", adminRouter);

// Admin source configs (CP-provisioned feed source configurations — ES256 JWT auth)
import { adminSourceConfigsRouter } from "@synap/api";
app.route("/api/admin/source-configs", adminSourceConfigsRouter);

// Legacy provisioning integration endpoints. New external identity and access
// flows are mounted separately under /api/federation and do not depend on this
// product-specific compatibility surface.
import { provisionRouter, podDiagnosticsReader } from "./routers/provision.js";
app.route("/api/provision", provisionRouter);

import { federationRouter } from "./routers/federation.js";
app.route("/api/federation", federationRouter);

// Account recovery (pod recovery codes, Cloud trust, "Can't sign in?" doors).
// Contract: @synap-core/types/account-recovery.
import { createAccountRecoveryRouter } from "./routers/account-recovery.js";
import { accountRecoveryDeps } from "./routers/account-recovery-deps.js";
app.route(
  "/api/account-recovery",
  createAccountRecoveryRouter(accountRecoveryDeps)
);

// Pod updates (U3 auto-update setting + U4 last outcome) — owner settings
// door. The CP reads the same facts from /api/provision/status `updates`.
import { createPodUpdatesRouter } from "./routers/pod-updates.js";
import { podUpdatesDeps } from "./routers/pod-updates-deps.js";
app.route("/api/pod-updates", createPodUpdatesRouter(podUpdatesDeps));
import { createPodRateLimitsRouter } from "./routers/pod-rate-limits.js";
import {
  podRateLimitsDeps,
  readPodRateLimitValuesRaw,
} from "./routers/pod-rate-limits-deps.js";
app.route("/api/pod-rate-limits", createPodRateLimitsRouter(podRateLimitsDeps));
// The owner's budgets over the env, re-read every 30 s (rate-limit-classes.ts).
watchPodRateLimits(readPodRateLimitValuesRaw);

// The owner's restic recovery kit: download (fresh sign-in) + read-back confirm.
import { createBackupKitRouter } from "./routers/backup-kit.js";
import { backupKitDeps } from "./routers/backup-kit-deps.js";
app.route("/api/backup", createBackupKitRouter(backupKitDeps));

// Connector sync endpoint (ES256 JWT from CP, pulls records from Nango)
import { connectorsRouter as connectorsRestRouter } from "./routers/connectors.js";
app.route("/api/connectors", connectorsRestRouter);

// Unified inbound webhook surface — all third-party providers under /api/webhooks/*
// Auth is per-provider (HMAC, Bearer token, or static secret — handled inside each router).
// /api/webhooks/messaging  → Unipile (messaging events)
// /api/webhooks/n8n        → N8N inbox ingestion
// /api/webhooks/kratos     → Ory Kratos identity updates
// /api/webhooks/intelligence → IS analysis callbacks
import { n8nWebhookRouter } from "./webhooks/n8n.js";
import { kratosWebhookRouter } from "./webhooks/kratos.js";
import { intelligenceWebhookRouter } from "./webhooks/intelligence.js";
app.route("/api/webhooks", webhooksInboundRouter);
app.route("/api/webhooks/n8n", n8nWebhookRouter);
app.route("/api/webhooks/kratos", kratosWebhookRouter);
app.route("/api/webhooks/intelligence", intelligenceWebhookRouter);

// Pod-to-Pod Sync receive endpoint (Bearer token auth from registered peers)
import { syncReceiveApp } from "@synap/api";
import { brandIconsApp } from "@synap/api";
app.route("/api/sync", syncReceiveApp);

// Hub Protocol tRPC bridge — Bearer API-key authenticated tRPC surface used by
// the synap CLI and external agents (procedures: entities, profiles, relations,
// views, sessions, automations, commands, skills, …). Registered BEFORE the
// REST app mount at /api/hub so the /trpc subtree can't be shadowed by it.
// Auth is enforced per-procedure via scopedProcedure (apiKeyMiddleware reads
// the Authorization header from ctx.req).
const hubTrpcBodyMethods = new Set([
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
] as const);
type HubTrpcBodyMethod = "json" | "text" | "arrayBuffer" | "blob" | "formData";

app.use("/api/hub/trpc/*", async (c) => {
  const req =
    c.req.method === "GET" || c.req.method === "HEAD"
      ? c.req.raw
      : new Proxy(c.req.raw, {
          get(target, prop) {
            if (hubTrpcBodyMethods.has(prop as HubTrpcBodyMethod)) {
              const m = prop as HubTrpcBodyMethod;
              return () => c.req[m]();
            }
            return Reflect.get(target, prop, target);
          },
        });

  const context = await createApiContext(req, c);

  const res = await fetchRequestHandler({
    endpoint: "/api/hub/trpc",
    req,
    router: hubProtocolRouter,
    maxBatchSize: TRPC_MAX_BATCH_SIZE,
    createContext: async () => context as any,
    onError({ error, path }) {
      apiLogger.error({ err: error, path }, "hub tRPC error");
    },
  });

  return c.newResponse(res.body, res);
});

// Hub Protocol REST adapter (for Intelligence Service; API key auth)
app.route("/api/hub", hubProtocolRestApp);
// Alias: some hub clients use /api/hub-protocol prefix
app.route("/api/hub-protocol", hubProtocolRestApp);

// Integrations capabilities discovery (public, no auth)
app.route("/api/integrations/capabilities", integrationsCapabilitiesApp);

// Channel Gateway REST adapter (for external channel bots; X-Channel-Key auth)
import { channelGatewayApp } from "./routers/channel-gateway.js";
app.route("/api/channels/gateway", channelGatewayApp);

// MCP Server endpoint (for external agents: Claude Code, Claude Desktop, Cursor, …)
// Auth: Hub Protocol API key via Authorization: Bearer <key>
// Protocol: JSON-RPC 2.0 over HTTP POST
app.route("/mcp", mcpHttpApp);

// The pod as its OWN OAuth 2.1 authorization server (Path B — claude.ai talks
// straight to this pod, no control plane in the trust path).
//
// Mounted at the ROOT because RFC 8414 §3 fixes `/.well-known/oauth-
// authorization-server` at the issuer's origin and every other endpoint is
// derived from that same issuer (`${PUBLIC_URL}/register|/authorize|/token`),
// so none of them may sit under an `/api` prefix. Mounting a sub-app at "/"
// registers only ITS declared paths — unmatched requests fall through to the
// handlers below, so this does not shadow anything.
//   GET  /.well-known/oauth-protected-resource[/mcp]    (RFC 9728)
//   GET  /.well-known/oauth-authorization-server[/mcp]  (RFC 8414)
//   POST /register   (RFC 7591 DCR — public)
//   GET  /authorize  (PKCE S256 → pod-admin consent screen)
//   POST /token      (code → an `api_keys` row; PKCE verifier enforced)
app.route("/", oauthApp);
// GET /.well-known/synap-pod-jwks — the public half of this pod's identity key
// Public + cacheable; the CP trusts only the key registered with it.
// POST /.well-known/synap-pod-proof — signs a client's nonce with that key, so
// an app following a moved pod can check the new host holds it (plan D3).
app.route("/", podIdentityJwksApp);

// External API — Skills invocation (API key auth, scope: skills.invoke)
// GET  /api/external/skills         — list active skills
// POST /api/external/skills/:id/invoke — invoke a skill
app.route("/api/external/skills", externalSkillsApp);

// External API — Conversational chat proxy (API key auth, scope: chat.stream)
// GET  /api/external/chat/channels — list channels user can chat in
// POST /api/external/chat/stream   — proxy to IS chat stream (SSE)
app.route("/api/external/chat", externalChatApp);

// Session-auth chat stream — mirrors /api/external/chat/stream but uses
// the ory session middleware so clients like Relay mobile (which have a
// Kratos session token, not an API key) can stream AI responses over
// plain SSE. The upstream `orySessionMiddleware` is already applied to
// all /api/* paths, so no extra auth wiring is needed here.
// POST /api/chat/stream — session-authed IS chat proxy (SSE)
app.route("/api/chat", chatStreamApp);

// Live structure progress tail (same session auth as /api/chat). Read-only:
// GET /api/capture/runs/:captureRunId/progress — SSE frames of a running
// capture.structure call that carries the same captureRunId.
app.route("/api/capture", captureProgressStreamApp);

// OpenAI-compatible chat completions API (API key auth, scope: chat.stream)
// POST /v1/chat/completions — OpenAI format request/response with SSE streaming
// GET  /v1/models           — list available model aliases
app.route("/v1", openaiCompatApp);

// File Upload REST endpoint (multipart/form-data — not tRPC)
// Auth: Kratos session cookie (applied inside fileUploadApp)
app.route("/api/files", fileUploadApp);

// Dictation speech-to-text (multipart — not tRPC). Pod → IS over Hub Protocol.
// GET|POST /api/media/transcribe — auth applied inside mediaTranscribeApp.
// Each POST is a paid Whisper call, so it shares the AI limit with chat. Hono
// runs middleware in registration order: this MUST precede the route mount.
app.use("/api/media/transcribe", aiRateLimitMiddleware);
app.route("/api/media", mediaTranscribeApp);

// AI rate limiting — charged once per AI procedure in the request, batched or
// not (chat.sendMessage, channels.sendMessage). See trpc-ai-rate-limit.ts.
app.use("/trpc/*", trpcAiRateLimit(aiRateLimitMiddleware));

// tRPC endpoint
// NOTE: Using fetchRequestHandler directly from @trpc/server instead of
// @hono/trpc-server to avoid version mismatch (hono adapter resolves its own
// @trpc/server@11.8.1, but the app uses @trpc/server@11.16.0).
const bodyMethods = new Set([
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
] as const);
type BodyMethod = "json" | "text" | "arrayBuffer" | "blob" | "formData";

app.use("/trpc/*", async (c) => {
  const endpoint = "/trpc";

  const req =
    c.req.method === "GET" || c.req.method === "HEAD"
      ? c.req.raw
      : new Proxy(c.req.raw, {
          get(target, prop) {
            if (bodyMethods.has(prop as BodyMethod)) {
              const m = prop as BodyMethod;
              return () => c.req[m]();
            }
            return Reflect.get(target, prop, target);
          },
        });

  const context = await createApiContext(req, c);

  apiLogger.info(
    {
      workspaceId: context.workspaceId,
      userId: context.userId,
      authenticated: context.authenticated,
      hasSession: !!context.session,
      hasUser: !!context.user,
    },
    "tRPC createContext - Using centralized context creation"
  );

  const res = await fetchRequestHandler({
    endpoint,
    req,
    router: appRouter,
    maxBatchSize: TRPC_MAX_BATCH_SIZE,
    createContext: async () => context as any,
    onError({ error, path }) {
      apiLogger.error({ err: error, path }, "tRPC error");
    },
  });

  markTrpcAnswer(c);
  return c.newResponse(res.body, res);
});

// pg-boss is initialized in the server startup callback below

// ── First-admin setup page ─────────────────────────────────────────────────
//
// Served at GET /setup. If a ?token= query param is present, shows a form
// to create the first admin account. Without a token, shows an error page.
// The form POSTs to /api/hub/setup/first-admin via fetch (no full-page reload).
import { renderSetupPage } from "./setup-page.js";
app.get("/setup", (c) =>
  c.html(renderSetupPage(Boolean(c.req.query("token"))), 200, {
    "Referrer-Policy": "no-referrer",
  })
);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// Error handler
app.onError((err, c) => {
  const errorId = crypto.randomUUID();
  // Use existing apiLogger (created at line 50) instead of creating new one

  // HTTPException carries its own status code — let it flow through directly
  // instead of converting it to InternalServerError(500) via toSynapError.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // Convert to SynapError if needed (standardized error handling)
  const synapError = isSynapError(err)
    ? err
    : toSynapError(err, "An unexpected error occurred");

  // Only log stack trace for 5xx errors or in development
  const shouldLogStack =
    synapError.statusCode >= 500 || config.server.nodeEnv === "development";

  // A server fault logs the ORIGINAL error, not the wrapper `toSynapError`
  // made ("An unexpected error occurred", its own stack): pino's serializer
  // gives the original's name, message, stack and `cause` chain. The egress
  // door (middleware/error-egress.ts) stores it under the same errorId.
  const logged = synapError.statusCode >= 500 ? err : synapError;
  apiLogger[synapError.statusCode >= 500 ? "error" : "warn"](
    {
      err: logged,
      errorId,
      // Redacted: a 4xx/5xx on a secret-in-path route (calendar feed, agent
      // setup) would otherwise file the capability into the error log.
      path: redactSecretPath(c.req.path),
      method: c.req.method,
      statusCode: synapError.statusCode,
      ...(shouldLogStack && { stack: logged.stack }),
    },
    synapError.statusCode >= 500 ? "Server error" : "Client error"
  );

  const isDev = config.server.nodeEnv === "development";

  // Return standardized error response
  // Cast statusCode to satisfy Hono's type requirements
  const statusCode = synapError.statusCode as
    400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

  // 5xx = server fault. `toSynapError()` puts the ORIGINAL error's message and
  // stack into `context` ({ originalError, stack }), so spreading `context`
  // unconditionally shipped the raw driver text — for a Drizzle failure that is
  // the entire SQL statement plus every bound parameter — to the caller. The
  // pre-existing `isDev` gate below only covered `errorId`/`stack` and never
  // `context`, which already carried both.
  //
  // 4xx keeps `context`: validation errors legitimately carry field-level
  // detail and clients render it. Only a server fault is opaque.
  //
  // `errorId` is now ALWAYS returned on 5xx (not dev-only) — it is the sole
  // thread from a user's bug report back to the full stack in the server log,
  // and it carries no internal detail itself.
  const isServerFault = statusCode >= 500;
  if (isServerFault && !isDev) {
    return c.json(
      {
        error: synapError.name,
        code: synapError.code,
        message: "An unexpected server error occurred",
        errorId,
      },
      statusCode
    );
  }

  return c.json(
    {
      error: synapError.name,
      code: synapError.code,
      message: synapError.message,
      ...(synapError.context && { context: synapError.context }),
      ...(isServerFault && { errorId }),
      ...(isDev && {
        errorId,
        ...(shouldLogStack && { stack: synapError.stack }),
      }),
    },
    statusCode
  );
});

// Schema coherence tripwire — blocks startup if the live DB is missing any
// critical column the Drizzle schema requires. Runs AFTER migrations have
// been applied (the migration runner is a separate process) and BEFORE the
// HTTP server starts listening, so a drifted pod never serves traffic.
//
// We run this inside an async IIFE so it blocks the rest of bootstrap —
// serve() is only called if the check (and the check alone) resolves.
await (async () => {
  try {
    const { validateSchemaCoherence } = await import("@synap/database");
    await validateSchemaCoherence();
    apiLogger.info("Schema coherence check passed");
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Schema coherence check failed — refusing to start"
    );
    // Print the structured error so ops sees the full list of missing columns
    // in plain text (not JSON-wrapped by the logger).
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
})();

// Ontology conversions — the ledger-idempotent DATA-migration runner (the
// conversion manifest SSOT: packages/database/src/conversions/manifest.ts).
//
// Runs AFTER migrations + schema coherence, BEFORE serve() — same startup
// discipline as the schema check above:
//   - Non-destructive ops apply automatically, once. The `_conversions` ledger
//     records applied opKeys, so every subsequent boot skips them (no re-work).
//   - Destructive-tail ops (profile deactivation in mergeInto / dedupe) are
//     DEFERRED, never auto-applied — logged loudly as pending operator action
//     and listed on /status/release (conversions.pending). The operator
//     completes each deliberately, one op at a time, dry run first:
//       tsx src/scripts/run-conversions.ts --only <opKey>
//       tsx src/scripts/run-conversions.ts --apply --only <opKey> --destructive-tail
//     (the engine refuses a destructive-tail op on --apply without the tail).
//   - A failing op ABORTS startup non-zero (a drifted ontology never serves).
//   - Kill-switch: SYNAP_SKIP_CONVERSIONS=1 skips the whole pass with a warn.
await (async () => {
  if (process.env.SYNAP_SKIP_CONVERSIONS === "1") {
    apiLogger.warn(
      "Ontology conversions SKIPPED (SYNAP_SKIP_CONVERSIONS=1) — the manifest " +
        "will not be applied this boot"
    );
    return;
  }
  try {
    const { sql, runConversions, CONVERSION_MANIFEST, withAdvisoryLock } =
      await import("@synap/database");
    // deferDestructive + skipDeferred (see BOOT_CONVERSION_OPTIONS): a data
    // cutover or profile retirement never auto-applies at deploy.
    //
    // Under one advisory lock: a split pod boots its api and worker processes
    // at once, both run this pass, and the ledger skips only what is already
    // recorded. The second process waits, then finds every op in the ledger,
    // so neither serves or works before the conversions landed.
    const summary = await withAdvisoryLock("synap-boot", "conversions", () =>
      runConversions(sql, CONVERSION_MANIFEST, BOOT_CONVERSION_OPTIONS)
    );

    // Severity axis: a FATAL op's apply-failure is unsafe to serve → exit(1).
    // An ADVISORY op's failure (value-remap / scope; data stays dual-readable)
    // → WARN + CONTINUE, recording a structured degraded signal (never silently
    // swallowed). The engine stamps `severity` on each error result and halts
    // at the first failure (canary posture), so there is at most one here.
    const failures = summary.results.filter((r) => r.status === "error");
    const fatal = failures.filter((r) => (r.severity ?? "fatal") === "fatal");
    const advisory = failures.filter((r) => r.severity === "advisory");

    if (fatal.length > 0) {
      const f = fatal[0];
      throw new Error(
        `Conversion op '${f.opKey}' (${f.op}) failed: ${f.error ?? "unknown error"}`
      );
    }

    conversionsBootState = conversionsBootStateFromSummary(summary);

    if (advisory.length > 0) {
      apiLogger.warn(
        {
          event: "boot.conversions.degraded",
          ops: advisory.map((r) => ({
            opKey: r.opKey,
            op: r.op,
            error: r.error,
          })),
        },
        "Ontology conversions DEGRADED — advisory op(s) failed to apply; the pod " +
          "is serving with UN-MIGRATED data for those ops. Surfaced on " +
          "/status/release (conversions.degraded). Fix the cause and reboot to retry."
      );
    }

    const applied = summary.results.filter(
      (r) => r.status === "applied" || r.status === "noop"
    ).length;
    const skipped = summary.results.filter(
      (r) => r.status === "skipped"
    ).length;
    const deferred = summary.results.filter((r) => r.status === "deferred");

    apiLogger.info(
      {
        applied,
        skipped,
        deferred: deferred.length,
        degraded: advisory.length > 0,
      },
      `Ontology conversions: applied ${applied}, skipped ${skipped} (ledger), ` +
        `deferred ${deferred.length} (destructive-tail / deferAtBoot)`
    );

    if (deferred.length > 0) {
      apiLogger.warn(
        {
          ops: deferred.map((r) => ({ opKey: r.opKey, reason: r.deferReason })),
        },
        "Ontology conversions: deferred op(s) PENDING operator action (listed on " +
          "/status/release conversions.pending). In @synap/database, per op, dry " +
          "run first: `tsx src/scripts/run-conversions.ts --only <opKey>`, then " +
          "`--apply --only <opKey>` — adding `--destructive-tail` for a " +
          "destructive-tail op (the engine refuses it without)."
      );
    }
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Ontology conversions failed — refusing to start"
    );
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
})();

// WebSocket upgrade router — handles SSH proxy and recipe runner endpoints
import { handleWebSocketUpgrade } from "./ws-router.js";
import { serverBindHostname } from "./server-bind.js";
import {
  startBackground,
  type StarterContext,
} from "./process-role/background-starters.js";
import {
  createWorkerHealthApp,
  httpFetchFor,
} from "./process-role/worker-health.js";

// Start server
// The role decides what this process serves and starts (process-role/):
// `all` and `api` serve the whole app, `worker` only /health. Everything else
// the backend starts is a declared starter, run in two phases: `boot` right
// after serve() returns, `listening` once the port is bound.
const starterContext: StarterContext = {
  role: processRole,
  localMode: config.server.localMode,
  log: apiLogger,
  boss: { started: false },
};
try {
  const httpServer = serve(
    {
      fetch: httpFetchFor(processRole, app, () =>
        createWorkerHealthApp(() => ({
          bossStarted: starterContext.boss.started,
          eventLoop: eventLoopWatch.snapshot(),
        }))
      ),
      port: config.server.port,
      hostname: serverBindHostname(config.server.localMode),
    },
    async (info) => {
      apiLogger.info(
        {
          port: info.port,
          host: serverBindHostname(config.server.localMode),
          nodeEnv: config.server.nodeEnv,
          processRole,
        },
        processRole === "worker"
          ? "Worker started (HTTP serves /health only)"
          : "API server started"
      );
      await startBackground(starterContext, "listening");
    }
  );

  // Register WebSocket upgrade router.
  // Routes /api/devplane/ssh to the SSH proxy and /api/devplane/recipe-run to
  // the recipe runner. All other upgrade paths are destroyed to avoid conflicts
  // with Hono SSE or other upgrade handlers. A worker serves no WebSocket.
  if (processRole !== "worker") {
    httpServer.on("upgrade", handleWebSocketUpgrade);
    apiLogger.info(
      "WebSocket endpoints registered: /api/devplane/ssh, /api/devplane/recipe-run"
    );
  }
} catch (err) {
  apiLogger.error({ err }, "CRITICAL: Failed to start server");
  process.exit(1);
}

void startBackground(starterContext, "boot");

// `validateCriticalSecrets` is CALLED in the pre-serve config block above —
// ES imports are hoisted, so the binding is available when that block
// evaluates. The startup hooks themselves are a starter (process-role/).
import { startupHooksState, validateCriticalSecrets } from "./startup-hooks.js";

// Process-level error handlers — catch anything that escapes the request cycle
process.on("unhandledRejection", (reason) => {
  apiLogger.error({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  apiLogger.error({ error }, "Uncaught exception");
  process.exit(1);
});

// Graceful shutdown
["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal, async () => {
    apiLogger.info(`${signal} received, shutting down gracefully`);
    if (config.server.localMode) {
      stopLocalSyncDriver();
    }
    eventLoopWatch.stop();
    try {
      usageTelemetry.stop();
      await usageTelemetry.flushNow();
    } catch (err) {
      apiLogger.error({ err }, "Error flushing usage telemetry");
    }
    try {
      await stopBoss();
      apiLogger.info("pg-boss stopped");
    } catch (err) {
      apiLogger.error({ err }, "Error stopping pg-boss");
    }
    process.exit(0);
  });
});

export default app;
