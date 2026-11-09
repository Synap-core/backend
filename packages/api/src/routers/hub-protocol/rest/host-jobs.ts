/**
 * Hub Protocol REST — host jobs, the host runner side (installations, 0409;
 * plan 64072312 U7; the ONE wire for both kinds, reconciliation f75fbb48
 * §3.2). The wire is `@synap-core/types/host-jobs`.
 *
 *   POST /host-jobs/lease            {capacity?, os?, arch?}  → {job | null}
 *   POST /host-jobs/:id/heartbeat    {leaseId, phase}         → {leaseExpiresAt, stopRequested, logsRequested}
 *   POST /host-jobs/:id/report       {leaseId, health?, verify?, observedVersion?, os?, arch?, log?} → {installationId, status}
 *   POST /host-jobs/:id/finish       {leaseId, status, …}     → {id, status, installationStatus}
 *   GET  /host-jobs/:id/logs                                  → {id, status, log, logReceivedAt, logsRequestedAt}
 *
 * WHO MAY CALL the runner routes: a COMPUTER (`users.agent_type = 'machine'`,
 * the device-flow key) whose key holds `host.runner`, the scope the person
 * turns on for that computer ("Installs from the pod",
 * `machines.setHostsServices`). Any other caller is refused before a row is
 * read — an agent HOSTED on that computer (`users.host_user_id`, Claude Code
 * on the Mac) included: it reads the computer's installations, it never
 * writes what the computer observed, so it cannot forge the record dispatch
 * relies on. A computer acts only on jobs of its OWN
 * person, for installations ON ITSELF; both floors are read off the rows,
 * never the request.
 *
 * `GET /:id/logs` is the OWNER's read (hub-protocol.read), through the access
 * layer: the owner floor and the key's grant (subject `installation`) apply,
 * so an agent key not granted installations reads nothing (404).
 *
 * START ORDER (as the box runner's): the runner starts containers only AFTER
 * a `phase:"running"` heartbeat answered 200; a 409 means the lease went
 * elsewhere, so it cleans up without finishing.
 *
 * Static `/host-jobs/lease` is registered BEFORE the `/:id` routes (Hono).
 * In the OpenAPI reference (the bodies are the wire's own schemas), so the
 * runner's contract is published with the pod's.
 */

import { z } from "zod";
import { z as zOpenapi } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, db, eq } from "@synap/database";
import { HOST_RUNNER_SCOPE, hostJobs, users } from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  HOST_BODY_MAX_BYTES,
  HostJobFinishBodySchema,
  HostJobHeartbeatBodySchema,
  HostJobLeaseBodySchema,
  HostJobReportBodySchema,
  type HostJobLogsAnswer,
} from "@synap-core/types/host-jobs";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  requireUuidParam,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { AccessContext, scopedDb } from "../../../access/index.js";
import {
  finishHostJob,
  heartbeatHostJob,
  leaseHostJob,
  noteHostRunner,
  reportHostJob,
  type HostLeaseRefusal,
  type HostObserved,
  type HostRunner,
} from "../../../services/host-jobs/host-jobs.js";
import { boxStatusForVerdict } from "../../../services/box-runs/box-runs.js";
import { reconcileComputer } from "../../../services/installations/installations.js";

/** What the runner observed, only the fields it sent (a tool's verify, …). */
function observedFrom(b: {
  observedVersion?: string | null;
  os?: string;
  arch?: string;
  verify?: HostObserved["verify"];
}): HostObserved {
  return {
    ...(b.observedVersion !== undefined
      ? { observedVersion: b.observedVersion }
      : {}),
    ...(b.os !== undefined ? { os: b.os } : {}),
    ...(b.arch !== undefined ? { arch: b.arch } : {}),
    ...(b.verify !== undefined ? { verify: b.verify } : {}),
  };
}

/**
 * The computer behind this request, or the refusal. Scope first (no read),
 * then the principal: the acting agent must be a computer, and the request's
 * person must be the computer's own person.
 */
export async function resolveHostRunner(c: {
  get: (k: "scopes" | "agentUserId" | "userId") => unknown;
}): Promise<
  | { ok: true; runner: HostRunner }
  | { ok: false; status: 401 | 403; code: string; error: string }
> {
  const scopes = (c.get("scopes") as string[] | undefined) ?? [];
  if (!hasScope(scopes, HOST_RUNNER_SCOPE)) {
    return {
      ok: false,
      status: 403,
      code: "SCOPE_REQUIRED",
      error: `Insufficient scope: ${HOST_RUNNER_SCOPE} required. Turn on "Installs from the pod" for this computer.`,
    };
  }
  const agentUserId = c.get("agentUserId") as string | undefined;
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      error: "Unauthorized",
    };
  }
  const [machine] = agentUserId
    ? await db
        .select({ id: users.id, owner: users.createdByUserId })
        .from(users)
        .where(
          and(
            eq(users.id, agentUserId),
            eq(users.agentType, MACHINE_AGENT_TYPE)
          )
        )
        .limit(1)
    : [];
  if (!machine || !machine.owner || machine.owner !== userId) {
    return {
      ok: false,
      status: 403,
      code: "NOT_A_COMPUTER",
      error: "Only a connected computer's own key can run host jobs.",
    };
  }
  return {
    ok: true,
    runner: { machineUserId: machine.id, ownerUserId: machine.owner },
  };
}

const REFUSAL_HTTP = { NOT_FOUND: 404, LEASE_LOST: 409 } as const;
const REFUSAL_TEXT = {
  NOT_FOUND: "No such host job for an installation on this computer.",
  LEASE_LOST:
    "This lease is no longer held (expired and re-leased, stale lease id, or the job finished). Clean up what you started; do not finish.",
} as const;

export function registerHostJobsRoutes(app: HubHono): void {
  const refused = (
    c: Context<{ Variables: HubVariables }>,
    r: HostLeaseRefusal
  ) =>
    c.json({ code: r.code, error: REFUSAL_TEXT[r.code] }, REFUSAL_HTTP[r.code]);

  app.use(
    "/host-jobs/*",
    bodyLimit({
      maxSize: HOST_BODY_MAX_BYTES,
      onError: (c) =>
        c.json(
          {
            code: "PAYLOAD_TOO_LARGE",
            error: `The body is over ${HOST_BODY_MAX_BYTES} bytes. Send the log's head and tail only.`,
          },
          413
        ),
    })
  );

  registerHostJobsOpenApi(app);

  /** An absent body is `{}`; a body that is not JSON is refused, never `{}`. */
  async function body<T extends z.ZodTypeAny>(
    c: { req: { text: () => Promise<string> } },
    schema: T
  ): Promise<{ ok: true; data: z.output<T> } | { ok: false; error: string }> {
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, error: "body is not valid JSON" };
      }
    }
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return {
        ok: false,
        error: `${i?.path.join(".") || "body"}: ${i?.message ?? "invalid"}`,
      };
    }
    return { ok: true, data: parsed.data };
  }

  // ── POST /host-jobs/lease (static, BEFORE /:id) ─────────────────────────
  app.post("/host-jobs/lease", async (c) => {
    const who = await resolveHostRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const parsed = await body(c, HostJobLeaseBodySchema);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    try {
      // The pod-side reconciler first: each installation on this computer
      // gets the ONE job it is due (a verify past its cadence, a repair),
      // so a computer waking from sleep finds one job each, never a pile.
      // A runner that came back (a new process, or a long gap) has every
      // tool on the computer checked again (self-heal): `runner` is the
      // runner process's id, sent by synap-cli in the lease body (the
      // schema passes unknown fields through, so an older pod ignores it).
      const runnerId = (parsed.data as { runner?: unknown }).runner;
      const cameBack = await noteHostRunner(
        who.runner,
        typeof runnerId === "string" ? runnerId : null
      );
      await reconcileComputer(who.runner, { recheckTools: cameBack });
      const job = await leaseHostJob(who.runner, parsed.data);
      return c.json({ job });
    } catch (err) {
      logger.error({ err }, "host-jobs lease failed");
      return c.json(
        { code: "INTERNAL", error: "Lease failed" },
        httpStatusForTrpcError(err)
      );
    }
  });

  // ── POST /host-jobs/:id/heartbeat ────────────────────────────────────────
  app.post("/host-jobs/:id/heartbeat", async (c) => {
    const who = await resolveHostRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const jobId = requireUuidParam(c, "id");
    if (jobId instanceof Response) return jobId;
    const parsed = await body(c, HostJobHeartbeatBodySchema);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    const out = await heartbeatHostJob({
      jobId,
      leaseId: parsed.data.leaseId,
      phase: parsed.data.phase,
      runner: who.runner,
    });
    if (!out.ok) return refused(c, out);
    return c.json({
      leaseExpiresAt: out.leaseExpiresAt,
      stopRequested: out.stopRequested,
      logsRequested: out.logsRequested,
    });
  });

  // ── POST /host-jobs/:id/report ───────────────────────────────────────────
  app.post("/host-jobs/:id/report", async (c) => {
    const who = await resolveHostRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const jobId = requireUuidParam(c, "id");
    if (jobId instanceof Response) return jobId;
    const parsed = await body(c, HostJobReportBodySchema);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    const out = await reportHostJob({
      jobId,
      leaseId: parsed.data.leaseId,
      runner: who.runner,
      ...(parsed.data.health ? { health: parsed.data.health } : {}),
      ...(parsed.data.log ? { log: parsed.data.log } : {}),
      ...observedFrom(parsed.data),
    });
    if (!out.ok) return refused(c, out);
    return c.json({ installationId: out.installationId, status: out.status });
  });

  // ── POST /host-jobs/:id/finish ───────────────────────────────────────────
  app.post("/host-jobs/:id/finish", async (c) => {
    const who = await resolveHostRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const jobId = requireUuidParam(c, "id");
    if (jobId instanceof Response) return jobId;
    const parsed = await body(c, HostJobFinishBodySchema);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    const b = parsed.data;
    const out = await finishHostJob({
      jobId,
      leaseId: b.leaseId,
      runner: who.runner,
      verdict: b.status,
      durationMs: b.durationMs ?? null,
      ...(b.infraReason ? { infraReason: b.infraReason.trim() } : {}),
      ...(b.steps ? { steps: b.steps } : {}),
      ...(b.log ? { log: b.log } : {}),
      ...(b.output ? { output: b.output } : {}),
      ...(b.cleanedUp ? { cleanedUp: b.cleanedUp } : {}),
      observed: observedFrom(b),
    });
    if (!out.ok) return refused(c, out);
    return c.json({
      id: out.job.id,
      status: boxStatusForVerdict(b.status),
      installationStatus: out.installationStatus,
    });
  });

  // ── GET /host-jobs/:id/logs (the owner) ──────────────────────────────────
  app.get("/host-jobs/:id/logs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const jobId = requireUuidParam(c, "id");
    if (jobId instanceof Response) return jobId;
    const userId = c.get("userId") as string;
    try {
      const job = await scopedDb(AccessContext.agent({ userId })).findFirst<
        typeof hostJobs.$inferSelect
      >(hostJobs, { where: eq(hostJobs.id, jobId) });
      if (!job) return c.json({ error: "Not found" }, 404);
      const answer: HostJobLogsAnswer = {
        id: job.id,
        status: job.status,
        log: job.log ?? null,
        logReceivedAt: job.logReceivedAt?.toISOString() ?? null,
        logsRequestedAt: job.logsRequestedAt?.toISOString() ?? null,
      };
      return c.json(answer);
    } catch (err) {
      logger.error({ err, jobId }, "host-jobs logs read failed");
      return c.json({ error: "Logs read failed" }, httpStatusForTrpcError(err));
    }
  });
}

/**
 * The host-job wire in the Hub OpenAPI reference. Bodies are the wire's own
 * schemas (`@synap-core/types/host-jobs`); answers are described as the
 * handlers above write them.
 */
function registerHostJobsOpenApi(app: HubHono): void {
  const runner =
    "Only a connected computer's own key holding `host.runner` " +
    '("Installs from the pod" on that computer); any other caller, an agent ' +
    "hosted on the computer included, is refused `NOT_A_COMPUTER` (403).";
  const IdParams = zOpenapi.object({ id: zOpenapi.string().uuid() });
  const refusals = {
    400: { description: "Bad request", schema: ErrorSchema },
    401: { description: "Unauthorized", schema: ErrorSchema },
    403: {
      description: "Not a computer, or no host.runner scope",
      schema: ErrorSchema,
    },
    404: {
      description: "No such job for an installation on this computer",
      schema: ErrorSchema,
    },
    409: { description: "The lease is no longer held", schema: ErrorSchema },
    413: { description: "The body is too large", schema: ErrorSchema },
  };
  registerOpenApi(app, {
    method: "post",
    path: "/host-jobs/lease",
    tags: ["HostJobs"],
    summary: "Lease the next host job of an installation on this computer",
    description:
      "Answers `{ job: null }` when nothing is due. The job names the " +
      "installation's kind (`service` | `tool`), its approved manifest and " +
      `version. ${runner}`,
    request: { body: HostJobLeaseBodySchema },
    responses: {
      200: {
        description: "The leased job, or null",
        schema: zOpenapi.object({
          job: zOpenapi
            .record(zOpenapi.string(), zOpenapi.unknown())
            .nullable(),
        }),
      },
      400: refusals[400],
      401: refusals[401],
      403: refusals[403],
      413: refusals[413],
    },
  });
  registerOpenApi(app, {
    method: "post",
    path: "/host-jobs/:id/heartbeat",
    tags: ["HostJobs"],
    summary: "Keep a host job's lease, and learn whether to stop or send logs",
    description: runner,
    request: { params: IdParams, body: HostJobHeartbeatBodySchema },
    responses: {
      200: {
        description: "The lease is extended",
        schema: zOpenapi.object({
          leaseExpiresAt: zOpenapi.string(),
          stopRequested: zOpenapi.boolean(),
          logsRequested: zOpenapi.boolean(),
        }),
      },
      ...refusals,
    },
  });
  registerOpenApi(app, {
    method: "post",
    path: "/host-jobs/:id/report",
    tags: ["HostJobs"],
    summary: "Report health, a verify or the requested log for a host job",
    description:
      "A report never moves the installation's lifecycle; health is read " +
      `from it. Logs are scrubbed of secrets before they are stored. ${runner}`,
    request: { params: IdParams, body: HostJobReportBodySchema },
    responses: {
      200: {
        description: "Stored",
        schema: zOpenapi.object({
          installationId: zOpenapi.string(),
          status: zOpenapi.string(),
        }),
      },
      ...refusals,
    },
  });
  registerOpenApi(app, {
    method: "post",
    path: "/host-jobs/:id/finish",
    tags: ["HostJobs"],
    summary: "Finish a host job with its verdict",
    description:
      "Moves the installation's lifecycle (installed, failed, removed) by " +
      `compare-and-set; a second finish is 409. ${runner}`,
    request: { params: IdParams, body: HostJobFinishBodySchema },
    responses: {
      200: {
        description: "Finished",
        schema: zOpenapi.object({
          id: zOpenapi.string(),
          status: zOpenapi.enum(["done", "failed", "stopped"]),
          installationStatus: zOpenapi.string(),
        }),
      },
      ...refusals,
    },
  });
  registerOpenApi(app, {
    method: "get",
    path: "/host-jobs/:id/logs",
    tags: ["HostJobs"],
    summary: "Read the log a computer sent for one of your host jobs",
    description:
      "The person's own job, read through the owner floor. `log` is null " +
      "until the computer sent it (ask for it first). Requires " +
      "hub-protocol.read scope; a scoped key needs `installation.read`.",
    request: { params: IdParams },
    responses: {
      200: {
        description: "The job's log",
        schema: zOpenapi.object({
          id: zOpenapi.string(),
          status: zOpenapi.string(),
          log: zOpenapi.unknown().nullable(),
          logReceivedAt: zOpenapi.string().nullable(),
          logsRequestedAt: zOpenapi.string().nullable(),
        }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
    },
  });
}
