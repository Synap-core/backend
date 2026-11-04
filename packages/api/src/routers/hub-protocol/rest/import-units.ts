/**
 * Hub Protocol REST — store-first bulk import (one queued job, not N requests)
 *
 *   POST /import/unit-uploads      mint the presigned PUT URLs of a BATCH of
 *                                  source files (≤ 100 per call); the bytes go
 *                                  straight to storage, never through the API
 *   POST /import/enqueue-units     ONE manifest (≤ 2000 units: title, body,
 *                                  properties, upload token) → one job (202)
 *   GET  /import/units-job/:jobId  poll it; `output` maps each unit key to
 *                                  stored {entityId} | proposed {proposalId} |
 *                                  failed {error}
 *
 * WHY: `/import/store-unit` costs one multipart request per unit. A 712-
 * recording Superwhisper import was 712+ hub requests paced under the per-key
 * rate limit, and still met 429s (finding 51e086d8). Here the hub cost is
 * N / 100 mints + 1 enqueue + the polls; the job stores every unit through the
 * SAME unit door `/import/store-unit` uses (`storeImportUnit`), so governance
 * stays per unit: a parked create is `proposed`, never a failure.
 */

import { z } from "zod";
import { getRequestApiKeyId, getRequestGrant } from "@synap/database";
import { HUB_WRITE_SOURCES } from "@synap-core/types/proposals";
import { getBoss } from "@synap/jobs";
import {
  IMPORT_UNITS_QUEUE,
  type ImportUnitsPayload,
} from "@synap/jobs/workers/import-units-worker.js";
import { grantWriteDenial } from "../../../utils/grant-write-check.js";
import {
  IMPORT_UNIT_UPLOADS_MAX,
  parseImportUnitUploadKey,
  requestImportUnitUploads,
} from "../../file-upload-presign.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  isUuid,
  logger,
  resolveActingContext,
  resolveActorId,
  uuidPathParam,
  type HubHono,
} from "./_shared.js";

/** Units one `POST /import/enqueue-units` call may carry. */
export const IMPORT_UNITS_MAX = 2000;

const UnitUploadsRequestSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(200),
        size: z.number().int().positive(),
      })
    )
    .min(1)
    .max(IMPORT_UNIT_UPLOADS_MAX),
});

const UnitUploadsResponseSchema = z.object({
  uploads: z.array(
    z.object({
      uploadUrl: z.string(),
      method: z.literal("PUT"),
      headers: z.object({ "Content-Type": z.string() }),
      uploadToken: z.string(),
      expiresAt: z.string(),
      maxBytes: z.number(),
    })
  ),
});

const EnqueueUnitsRequestSchema = z
  .object({
    /** Explicit pin for every unit; omit for pod-wide kinds (a note). */
    workspaceId: z.string().uuid().optional(),
    source: z.enum(HUB_WRITE_SOURCES).optional(),
    units: z
      .array(
        z.object({
          /**
           * The caller's stable id for the unit, namespaced by the caller
           * (`superwhisper:<recordingId>`). The create door's idempotency key:
           * a unit sent again lands on its first entity.
           */
          key: z.string().min(1).max(200),
          title: z.string().trim().min(1).max(500),
          profileSlug: z.string().min(1).max(100).optional(),
          content: z.string().max(200_000).optional(),
          description: z.string().max(5_000).optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
          /** A token from `POST /import/unit-uploads` (the PUT landed). */
          uploadToken: z.string().min(1).max(1024).optional(),
        })
      )
      .min(1)
      .max(IMPORT_UNITS_MAX),
  })
  .superRefine((body, ctx) => {
    const keys = new Set<string>();
    const tokens = new Set<string>();
    body.units.forEach((u, i) => {
      if (keys.has(u.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", i, "key"],
          message: `Duplicate unit key "${u.key}"`,
        });
      }
      keys.add(u.key);
      if (u.uploadToken) {
        if (tokens.has(u.uploadToken)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["units", i, "uploadToken"],
            message: "One upload backs one unit",
          });
        }
        tokens.add(u.uploadToken);
      }
    });
  });

const EnqueueUnitsResponseSchema = z.object({
  queued: z.literal(true),
  jobId: z.string().nullable(),
  unitCount: z.number(),
});

const UnitOutcomeSchema = z.union([
  z.object({
    status: z.literal("stored"),
    entityId: z.string(),
    audio: z.boolean(),
    audioSkippedReason: z.string().nullable(),
  }),
  z.object({
    status: z.literal("proposed"),
    proposalId: z.string().nullable(),
    audioSkippedReason: z.string().nullable(),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);

const UnitsJobStatusSchema = z.object({
  jobId: z.string(),
  state: z.string(),
  createdOn: z.union([z.string(), z.date()]).nullable(),
  completedOn: z.union([z.string(), z.date()]).nullable(),
  output: z
    .object({
      total: z.number(),
      stored: z.number(),
      proposed: z.number(),
      failed: z.number(),
      results: z.record(z.string(), UnitOutcomeSchema),
    })
    .nullable(),
});

const writeScope = (c: { get: (k: "scopes") => unknown }) =>
  hasScope(c.get("scopes") as string[], "hub-protocol.write");

export function registerImportUnitsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/import/unit-uploads",
    tags: ["Import"],
    summary: "Mint presigned upload URLs for a batch of import files",
    description: `Returns one presigned PUT URL per file (1..${IMPORT_UNIT_UPLOADS_MAX} per call, all or nothing). PUT each file's bytes to its uploadUrl with exactly the returned headers, then name its uploadToken on a unit of POST /import/enqueue-units. Per-mime caps as POST /files/uploads. 501 when this pod's storage cannot presign: use POST /import/store-unit.`,
    request: { body: UnitUploadsRequestSchema },
    responses: {
      200: { description: "Upload tickets", schema: UnitUploadsResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      413: { description: "A file is too large", schema: ErrorSchema },
      415: { description: "A file type is not allowed", schema: ErrorSchema },
      501: { description: "Storage cannot presign", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/import/enqueue-units",
    tags: ["Import"],
    summary: "Enqueue a store-first import of many units as one background job",
    description: `One manifest (1..${IMPORT_UNITS_MAX} units: key, title, body, properties, optional uploadToken from POST /import/unit-uploads) becomes ONE job on the import-units queue. The job stores each unit through the same door as POST /import/store-unit: the governed entity create, then the source file through the attach gate. Governance is per unit: a parked create is reported proposed with its proposalId, not failed. A unit key is the create door's idempotency key, so a unit sent again lands on its first entity. Poll GET /import/units-job/{jobId}.`,
    request: { body: EnqueueUnitsRequestSchema },
    responses: {
      202: { description: "Units queued", schema: EnqueueUnitsResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/import/units-job/{jobId}",
    tags: ["Import"],
    summary: "Poll a store-first import job",
    description:
      "The pg-boss state of a job from POST /import/enqueue-units. Only its submitter may read it. `output` (null until the job completes) maps each unit key to stored {entityId, audio}, proposed {proposalId} or failed {error}, with the counts. A null output is UNKNOWN, never success.",
    request: { params: z.object({ jobId: uuidPathParam }) },
    responses: {
      200: { description: "Job state", schema: UnitsJobStatusSchema },
      400: { description: "Malformed jobId", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such job for this caller", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /** POST /import/unit-uploads — a batch of presigned PUT URLs. */
  app.post("/import/unit-uploads", async (c) => {
    if (!writeScope(c)) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = UnitUploadsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    // Each file becomes a document once its unit is stored: the key's grant
    // must allow that before any URL is minted.
    const denial = await grantWriteDenial({
      subjectType: "document",
      action: "create",
      workspaceId: null,
    });
    if (denial) return c.json({ error: denial }, 403);

    try {
      const minted = await requestImportUnitUploads({
        userId,
        files: parsed.data.files,
      });
      if (!minted.ok) {
        return c.json(
          { error: minted.error, code: minted.code },
          minted.status
        );
      }
      return c.json({ uploads: minted.uploads }, 200);
    } catch (err) {
      logger.error({ err, userId }, "POST /import/unit-uploads failed");
      return c.json(
        { error: "Failed to prepare uploads" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /** POST /import/enqueue-units — one manifest, one job. */
  app.post("/import/enqueue-units", async (c) => {
    if (!writeScope(c)) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = EnqueueUnitsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }
    const body = parsed.data;

    // Confine a workspace-bound service key BEFORE the id reaches the acting
    // context or the job payload — same clamp as /import/store-unit.
    const workspaceId = getConfinedWorkspace(c, body.workspaceId) ?? null;
    const acting = await resolveActingContext(c, {
      workspaceId: workspaceId ?? undefined,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    const keyType = c.get("keyType") as string | undefined;
    // As getCaller: the IS names its persona per call, so its key's agent is
    // not replayed as the acting agent.
    const agentUserId =
      keyType === "is_internal"
        ? undefined
        : (c.get("agentUserId") as string | undefined);
    const actor = await resolveActorId(agentUserId, userId);
    if ("error" in actor) return c.json({ error: actor.error }, 400);

    // An upload names the user who minted it; refuse another user's up front
    // instead of failing each such unit in the job.
    const foreign = body.units.findIndex(
      (u) =>
        u.uploadToken !== undefined &&
        parseImportUnitUploadKey(u.uploadToken)?.userId !== userId
    );
    if (foreign !== -1) {
      return c.json(
        {
          error: `units[${foreign}].uploadToken is not an upload of this user — mint it with POST /import/unit-uploads`,
        },
        400
      );
    }

    // The key's grant bounds the job as it bounds the request: refuse here
    // what no unit could write (each unit still passes the gate in the job,
    // under the same grant).
    const kinds = [...new Set(body.units.map((u) => u.profileSlug ?? "note"))];
    const withFile = body.units.some((u) => u.uploadToken);
    for (const profileSlug of kinds) {
      const denial =
        (await grantWriteDenial({
          subjectType: "entity",
          action: "create",
          workspaceId,
          data: { profileSlug },
        })) ??
        (withFile
          ? await grantWriteDenial({
              subjectType: "entity",
              action: "update",
              workspaceId,
              data: { profileSlug },
            })
          : null);
      if (denial) return c.json({ error: denial }, 403);
    }

    try {
      const payload: ImportUnitsPayload = {
        userId,
        workspaceId,
        source: body.source ?? "cli",
        units: body.units.map((u) => ({
          key: u.key,
          title: u.title,
          profileSlug: u.profileSlug ?? "note",
          ...(u.content ? { content: u.content } : {}),
          ...(u.description ? { description: u.description } : {}),
          ...(u.properties ? { properties: u.properties } : {}),
          ...(u.uploadToken ? { uploadToken: u.uploadToken } : {}),
        })),
        scopes: (c.get("scopes") as string[]) ?? [],
        agentUserId: agentUserId ?? null,
        sessionId: (c.get("sessionId") as string | undefined) ?? null,
        keyType: keyType ?? null,
        keyWorkspaceId:
          (c.get("keyWorkspaceId") as string | null | undefined) ?? null,
        apiKeyId: getRequestApiKeyId() ?? null,
        grant: getRequestGrant() ?? null,
      };
      const jobId = await getBoss().send(IMPORT_UNITS_QUEUE, payload);
      logger.info(
        { userId, workspaceId, unitCount: body.units.length, jobId },
        "POST /import/enqueue-units — units queued"
      );
      return c.json(
        { queued: true as const, jobId, unitCount: body.units.length },
        202
      );
    } catch (err) {
      logger.error({ err, userId }, "POST /import/enqueue-units failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /** GET /import/units-job/:jobId — the job's state and per-unit outcome. */
  app.get("/import/units-job/:jobId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const jobId = c.req.param("jobId");
    // The column is a uuid: an unchecked id would reach Postgres and read as
    // a server fault.
    if (!isUuid(jobId)) {
      return c.json(
        {
          error:
            "jobId must be a full 36-character UUID — use the jobId returned by POST /import/enqueue-units",
        },
        400
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // includeArchive: a completed job moves to the archive within minutes,
      // and "completed" is exactly the state a poller waits for.
      const job = await getBoss().getJobById<{ userId?: string }>(
        IMPORT_UNITS_QUEUE,
        jobId,
        { includeArchive: true }
      );
      // Only the submitter may read it; anyone else gets the same 404 as a
      // job that does not exist (no existence oracle). The payload (grant,
      // transcripts) is never returned.
      if (!job || job.data?.userId !== userId) {
        return c.json({ error: "No such import job" }, 404);
      }
      return c.json({
        jobId,
        state: job.state,
        createdOn: job.createdOn ?? null,
        completedOn: job.completedOn ?? null,
        output:
          (job.output as Record<string, unknown> | null | undefined) ?? null,
      });
    } catch (err) {
      logger.error({ err, userId, jobId }, "GET /import/units-job failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
