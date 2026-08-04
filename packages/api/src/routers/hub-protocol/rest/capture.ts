/**
 * Hub Protocol REST — capture (AI-powered tab clustering, structure, execute)
 */

import { z } from "zod";

import { captureRouter } from "../../capture.js";
import { getDefaultActiveService } from "../../../utils/intelligence-routing.js";
import {
  storeEntitySourceBlob,
  SourceBlobTooLargeError,
  SourceBlobEmptyError,
  SOURCE_BLOB_MAX_BYTES,
} from "../../../utils/store-entity-source-blob.js";
import { db } from "@synap/database";
import { createHubProtocolCallerContext } from "../utils.js";
import { resolveCaptureActorUserId } from "../../../services/capture-agent/resolve-capture-actor.js";
import {
  submitCaptureGraph,
  CaptureGraphValidationError,
} from "../../../services/capture-agent/submit-capture-graph.js";
import { validateCaptureGraphRefs } from "./_capture-graph-dedup.js";
import {
  shouldPersistCapturePlan,
  captureStructureToGraph,
  type CaptureStructureLike,
} from "../../../services/capture-agent/capture-structure-to-graph.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CaptureGraphRawSourceSchema,
  CaptureExecuteRequestSchema,
  CaptureStructureRequestSchema,
  ClusterTabsRequestSchema,
  ClusterTabsResponseSchema,
  ImportRequestSchema,
  ImportApplyRequestSchema,
} from "./_codecs/misc.js";
import { ImportOrchestrator } from "../../../services/import-orchestrator.js";
import { AnalyzeLargeImportSchema } from "../../import.js";
import { getBoss } from "@synap/jobs";
import { IMPORT_CORPUS_QUEUE } from "@synap/jobs/workers/import-corpus-worker.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  resolveActingContext,
  hasScope,
  getCaller,
  isUuid,
  uuidPathParam,
  logger,
  type HubHono,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

/**
 * Body for POST /import/enqueue-corpus.
 *
 * Reuses the tRPC procedure's own schema (item caps + the 48MB aggregate byte
 * budget) so the two doors onto `analyzeLarge` can never drift apart. Adds only
 * the Hub-REST convention of an optional acting `userId` (service keys act for
 * a user; `resolveActingContext` rejects a mismatch on a session key).
 */
const ImportEnqueueCorpusRequestSchema = AnalyzeLargeImportSchema.extend({
  userId: z.string().min(1).optional(),
});

const EnqueueCorpusResponseSchema = z.object({
  queued: z.literal(true),
  jobId: z.string().nullable(),
  itemCount: z.number(),
  workspaceId: z.string().nullable(),
});

/**
 * File-level outcome of a finished corpus run — the pg-boss job `output`, which
 * is the worker's `ImportCorpusResult` projection of
 * `ImportOrchestrator.analyzeLarge`.
 *
 * `null` for a job that has not completed, AND for one completed by a pod that
 * predates the worker returning its result. A consumer must treat absence as
 * UNKNOWN, never as success: the numbers below are the only place a partially
 * failed import (e.g. files over the 8000-char structure cap) is visible.
 */
const CorpusJobOutputSchema = z
  .object({
    proposalId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    filesProcessed: z.number().optional(),
    filesFailed: z.number().optional(),
    qualityScore: z.number().optional(),
    findings: z
      .array(
        z.object({
          id: z.string().optional(),
          severity: z.string(),
          message: z.string(),
        })
      )
      .optional(),
  })
  .nullable();

const CorpusJobStatusSchema = z.object({
  jobId: z.string(),
  state: z.string(),
  createdOn: z.union([z.string(), z.date()]).nullable(),
  completedOn: z.union([z.string(), z.date()]).nullable(),
  output: CorpusJobOutputSchema,
});

const GRAPH_WRITE_SOURCES = new Set([
  "intelligence",
  "agent",
  "openwebui-pipeline",
  "extension",
  "cli",
  "n8n",
  "raycast",
] as const);
type GraphWriteSource =
  typeof GRAPH_WRITE_SOURCES extends Set<infer T> ? T : never;

export function registerCaptureRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/capture/cluster-tabs",
    tags: ["Capture"],
    summary: "Cluster open browser tabs into topic groups",
    description:
      "Forwards tabs to the Intelligence Service for AI clustering and returns a list of named clusters with each cluster's tabs.",
    request: {
      body: ClusterTabsRequestSchema,
    },
    responses: {
      200: { description: "Tab clusters", schema: ClusterTabsResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      502: { description: "Upstream IS error", schema: ErrorSchema },
      503: {
        description: "Clustering service unavailable",
        schema: ErrorSchema,
      },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/capture/structure",
    tags: ["Capture"],
    summary: "AI-structure raw input into entity proposals",
    description:
      "Sends free-form text (and optional URL/HTML/context) to the AI capture pipeline. Returns proposed entities ready for /capture/execute.",
    request: {
      body: CaptureStructureRequestSchema,
    },
    responses: {
      200: {
        description: "Structured entity proposals",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/capture/execute",
    tags: ["Capture"],
    summary: "Materialize structured proposals into entities",
    description:
      "Creates the proposed entities and relations from a /capture/structure response.",
    request: {
      body: CaptureExecuteRequestSchema,
    },
    responses: {
      200: {
        description: "Created entities + relations",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/import/analyze",
    tags: ["Import"],
    summary: "Structure import items into a preview graph",
    description:
      "AI/deterministic structure of markdown/obsidian/csv/bookmark items into composite operations + a governed import.graph proposal. Pair with POST /import/apply (proposalId is SSOT for ops).",
    request: {
      body: ImportRequestSchema,
    },
    responses: {
      200: {
        description: "Operations + proposalId for preview-before-apply",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/import/apply",
    tags: ["Import"],
    summary: "Materialize a previewed import graph",
    description:
      "Creates entities + relations from /import/analyze. When proposalId is set the stored proposal ops are SSOT (HITL); otherwise client operations (min 1) are required.",
    request: {
      body: ImportApplyRequestSchema,
    },
    responses: {
      200: {
        description: "Created + linked counts",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/import/enqueue-corpus",
    tags: ["Import"],
    summary: "Enqueue a large corpus import as a background job",
    description:
      "Background door onto ImportOrchestrator.analyzeLarge: enqueues the corpus on the `import-corpus` pg-boss queue and returns immediately with a jobId. The worker chunks the items (cross-chunk dedup preserved) and produces ONE governed import.graph proposal — so a many-file corpus is a single background job instead of N synchronous /import/analyze calls racing the request timeout. Poll GET /import/corpus-job/{jobId}; on completion the result is the import.graph proposal in the review inbox.",
    request: {
      body: ImportEnqueueCorpusRequestSchema,
    },
    responses: {
      202: {
        description: "Corpus queued",
        schema: EnqueueCorpusResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/import/corpus-job/{jobId}",
    tags: ["Import"],
    summary: "Poll a background corpus-import job",
    description:
      "Returns the pg-boss state of a job created by POST /import/enqueue-corpus. Only the job's own submitter may read it. `completed` means the governed import.graph proposal has been written — fetch it from the proposals inbox. `output` carries the run's file-level outcome (proposalId, filesProcessed/filesFailed, warn+blocker findings); it is null while the job is unfinished and on pods older than the worker that returns it — treat null as UNKNOWN, never as success.",
    request: {
      params: z.object({ jobId: uuidPathParam }),
    },
    responses: {
      200: { description: "Job state", schema: CorpusJobStatusSchema },
      400: { description: "Malformed jobId", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such job for this caller", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /import/enqueue-corpus
   *
   * Hub REST door onto the BACKGROUND large-import path — the same call
   * `trpc.import.enqueueLargeImport` makes (routers/import.ts). Nothing is
   * reimplemented here: chunking, cross-chunk dedup and the single governed
   * `import.graph` proposal all live in `ImportOrchestrator.analyzeLarge`,
   * which the worker reaches through the handler slot filled at api boot (IoC,
   * apps/api/src/index.ts). This route only validates, authorizes, and enqueues.
   *
   * WHY it exists: Hub REST previously exposed only the PER-FILE synchronous
   * `/import/analyze`, so a Hub-REST-speaking client (the CLI) had no way to
   * reach the chunked path and ran N synchronous requests against the request
   * timeout instead of one background job.
   *
   * Additive: `/import/analyze` and `/import/apply` are unchanged.
   */
  app.post("/import/enqueue-corpus", async (c) => {
    // Enqueues work that writes a durable import.graph proposal — same
    // write-scope floor as /import/analyze. Read-only keys must not queue jobs.
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.write") &&
      !hasScope(c.get("scopes") as string[], "mcp.write")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.write or mcp.write" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ImportEnqueueCorpusRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;

    // Confine a workspace-bound service key BEFORE the id reaches the acting
    // context or the job payload — same clamp as /import/store-unit.
    const workspaceId = getConfinedWorkspace(c, body.workspaceId);

    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: workspaceId ?? undefined,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // Byte-identical payload to trpc.import.enqueueLargeImport — the worker
      // reads exactly these four fields (ImportCorpusPayload).
      const jobId = await getBoss().send(IMPORT_CORPUS_QUEUE, {
        userId,
        workspaceId: acting.workspaceId,
        source: body.source,
        items: body.items,
      });

      logger.info(
        {
          userId,
          workspaceId: acting.workspaceId,
          source: body.source,
          itemCount: body.items.length,
          jobId,
        },
        "POST /import/enqueue-corpus — corpus queued"
      );

      return c.json(
        {
          queued: true as const,
          jobId,
          itemCount: body.items.length,
          workspaceId: acting.workspaceId,
        },
        202
      );
    } catch (err) {
      logger.error({ err, userId }, "POST /import/enqueue-corpus failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /import/corpus-job/:jobId
   *
   * Poll handle for the job returned by /import/enqueue-corpus.
   *
   * `jobId` is shape-checked before it reaches pg-boss: the column is a `uuid`,
   * so a truncated or mistyped id would make Postgres throw and the catch-all
   * below would report a CLIENT mistake as a 500. A malformed id is a 400.
   */
  app.get("/import/corpus-job/:jobId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const jobId = c.req.param("jobId");
    if (!isUuid(jobId)) {
      return c.json(
        {
          error:
            "jobId must be a full 36-character UUID — use the jobId returned by POST /import/enqueue-corpus",
        },
        400
      );
    }

    // Accept the SAME optional acting user the sibling POST accepts.
    //
    // `POST /import/enqueue-corpus` takes `body.userId`, so a SERVICE key
    // enqueues a job owned by that user. Without the mirror here, the poll
    // resolved to the key's own `authUserId`, the ownership floor found
    // `job.data.userId !== userId`, and the caller got a 404 on a job it had
    // just created. A user-linked agent key (the CLI) was unaffected, which is
    // exactly why the tests missed it.
    //
    // This grants no new authority: `resolveActingContext` already rejects a
    // mismatched `userId` on a session key, and the 404-not-403 floor below is
    // deliberate (no existence oracle).
    const acting = await resolveActingContext(c, {
      userId: c.req.query("userId"),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // includeArchive: a completed job moves to the archive table within
      // minutes, and "completed" is exactly the state a poller waits for.
      const job = await getBoss().getJobById<{ userId?: string }>(
        IMPORT_CORPUS_QUEUE,
        jobId,
        { includeArchive: true }
      );

      // Ownership floor: a jobId is guessable-adjacent and the payload carries
      // the corpus. Only the submitter may read it — an unrelated caller gets
      // the same 404 as a nonexistent job (no existence oracle).
      if (!job || job.data?.userId !== userId) {
        return c.json({ error: "No such corpus-import job" }, 404);
      }

      // ADDITIVE: the job's own output — the worker's ImportCorpusResult
      // (proposalId + quality counts + warn/blocker findings). Without it
      // "completed" was the ONLY signal a poller got, so a run that structured
      // 1 of 3 files and recorded filesFailed: 2 on the proposal was reported
      // as a clean success. Absence (older pod, or job not finished) is
      // `null` = UNKNOWN, and consumers must not read it as "nothing failed".
      const output =
        (job.output as Record<string, unknown> | null | undefined) ?? null;

      return c.json({
        jobId,
        state: job.state,
        createdOn: job.createdOn ?? null,
        completedOn: job.completedOn ?? null,
        output,
      });
    } catch (err) {
      logger.error({ err, userId, jobId }, "GET /import/corpus-job failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /capture/cluster-tabs
   */
  app.post("/capture/cluster-tabs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as {
      tabs?: Array<{
        url: string;
        title: string;
        favIconUrl?: string;
        tabId?: number;
        windowId?: number;
      }>;
    } | null;

    if (!body?.tabs?.length) {
      return c.json({ error: "tabs array required" }, 400);
    }

    // Canonical IS credential resolution (decrypted DB key), not stale env.
    const { endpoint: isUrl, apiKey: isApiKey } =
      await getDefaultActiveService();

    try {
      const simplifiedTabs = body.tabs.map(({ url, title }) => ({
        url,
        title,
      }));

      const res = await fetch(`${isUrl}/api/tools/cluster-tabs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({ tabs: simplifiedTabs }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        logger.warn(
          { status: res.status, err },
          "IS cluster-tabs returned error"
        );
        return c.json({ error: err.error ?? "IS error" }, 502);
      }

      const { clusters } = (await res.json()) as {
        clusters: Array<{
          name: string;
          icon: string;
          tabs: Array<{ url: string; title: string }>;
        }>;
      };

      const urlToFullTab = new Map(body.tabs.map((t) => [t.url, t]));

      const fullClusters = clusters.map((cluster) => ({
        name: cluster.name,
        icon: cluster.icon,
        tabs: cluster.tabs
          .map((t) => urlToFullTab.get(t.url))
          .filter((t): t is NonNullable<typeof t> => t !== undefined),
      }));

      return c.json({ clusters: fullClusters });
    } catch (err) {
      logger.error({ err }, "POST /capture/cluster-tabs failed");
      return c.json({ error: "Clustering service unavailable" }, 503);
    }
  });

  /**
   * POST /capture/structure
   */
  app.post("/capture/structure", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.read") &&
      !hasScope(c.get("scopes") as string[], "mcp.read")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.read or mcp.read" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Single source of truth: validate with the same codec the OpenAPI spec
    // publishes (avoids an inline shadow drifting from the published schema).
    const parsed = CaptureStructureRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      const scopes = c.get("scopes") as string[];
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId
      );
      const caller = captureRouter.createCaller(
        ctx as Parameters<typeof captureRouter.createCaller>[0]
      );
      const result = await caller.structure({
        text: body.text,
        file: body.file,
        url: body.url,
        html: body.html,
        context: body.context,
        instructions: body.instructions,
        previousEntities: body.previousEntities,
      });

      // ── CONFIRM MODE (the server holds the plan) ──────────────────────────
      // A HUMAN interactive caller (no agentUserId) gets the produced plan
      // PERSISTED as a pending composite proposal the moment it is offered — so
      // an abandoned plan is a visible uncommitted proposal, not silence. This
      // closes the false-success incident by construction: the human's later
      // confirmation is the EXISTING `proposals.approve(proposalId)`. An AGENT
      // caller (agentUserId set) still gets the ephemeral plan to drive its own
      // /capture/graph write. Degraded / clarifying-followUp / empty plans are
      // returned unchanged — we only change what happens AFTER a plan exists.
      const structureAgentUserId = c.get("agentUserId") as string | undefined;
      const structurePlan = result as CaptureStructureLike;
      if (!structureAgentUserId && shouldPersistCapturePlan(structurePlan)) {
        const { entities, relations } = captureStructureToGraph(structurePlan);
        // Placement is the structure procedure's already-resolved target (it ran
        // the one workspace-resolution door); never re-stamp the ambient lens.
        const targetWorkspaceId =
          typeof (result as { targetWorkspaceId?: unknown })
            .targetWorkspaceId === "string"
            ? ((result as { targetWorkspaceId?: string }).targetWorkspaceId ??
              null)
            : null;
        const graph = await submitCaptureGraph({
          userId,
          workspaceId: targetWorkspaceId,
          entities,
          relations,
        });
        return c.json({
          proposalId: graph.proposalId,
          reviewUrl: graph.reviewUrl,
          status: "awaiting_confirmation",
          summary: graph.summary,
          entityCount: graph.entityCount,
          relationCount: graph.relationCount,
          ...(graph.projectCandidate
            ? { projectCandidate: graph.projectCandidate }
            : {}),
        });
      }

      return c.json(result);
    } catch (err) {
      // A structurally un-materializable graph is a client-input fault (missing
      // a required property), rejected before anything is queued → 400, message
      // preserved so the caller can fix the entity and retry.
      if (err instanceof CaptureGraphValidationError) {
        return c.json({ error: err.message }, 400);
      }
      logger.error({ err, userId }, "POST /capture/structure failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /capture/execute
   */
  app.post("/capture/execute", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.write") &&
      !hasScope(c.get("scopes") as string[], "mcp.write")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.write or mcp.write" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Single source of truth: validate with the same codec the OpenAPI spec
    // publishes (CaptureExecuteRequestSchema). An inline duplicate here once
    // silently dropped the entity `content` field (Zod strips unknown keys),
    // which broke long-form document materialization end-to-end.
    const parsed = CaptureExecuteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      const scopes = c.get("scopes") as string[];
      // Thread the seeded Capture agent as the acting agent for the capture
      // pipeline (always — this endpoint IS the capture flow). NOTE: /capture/
      // execute is a direct first-party write (captureRouter.execute uses
      // entityRepo.create directly and does NOT call checkPermissionOrPropose),
      // so auto-apply does not depend on this — the actor is carried for
      // provenance/consistency with the header-gated shared routes. Graceful
      // fallback to the caller's own id if the Capture agent isn't seeded yet.
      const captureActorUserId = await resolveCaptureActorUserId(c, undefined, {
        always: true,
      });
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId,
        null,
        null,
        captureActorUserId
      );
      const caller = captureRouter.createCaller(
        ctx as Parameters<typeof captureRouter.createCaller>[0]
      );
      // Event-mode scoping: forward the active focus session (X-Session-Id) so
      // captured entities link to it via `session --produced--> entity`. Same
      // header the entities door reads; absent = unchanged behavior.
      const sessionId = c.get("sessionId") || undefined;

      const result = await caller.execute({
        entities: body.entities,
        relations: body.relations ?? [],
        projectId: body.projectId ?? undefined,
        targetWorkspaceId: body.targetWorkspaceId ?? undefined,
        keepRaw: body.keepRaw,
        file: body.file,
        idempotencyKey: body.idempotencyKey,
        // Forward workspace routing so this door auto-routes like MCP.
        workspaceRouting: body.workspaceRouting,
        aiWorkspaceId: body.aiWorkspaceId,
        aiWorkspaceConfidence: body.aiWorkspaceConfidence,
        aiWorkspaceReason: body.aiWorkspaceReason,
        sessionId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "POST /capture/execute failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /import/analyze
   *
   * SSOT: delegates to ImportOrchestrator.analyze (same as tRPC import.analyze).
   * Returns operations + proposalId + sessionId for preview-before-apply.
   * Human apply is POST /import/apply with the SAME operations (no re-structure).
   */
  app.post("/import/analyze", async (c) => {
    // Analyze writes a durable import.graph proposal (+ may mint a focus session).
    // Require write scopes — read-only keys must not spam proposals.
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.write") &&
      !hasScope(c.get("scopes") as string[], "mcp.write")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.write or mcp.write" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ImportRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      const scopes = c.get("scopes") as string[];
      const trpcCtx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId
      );
      const orchestrator = new ImportOrchestrator({
        workspaceId: workspaceId ?? null,
        userId,
        trpcCtx: trpcCtx as unknown as Record<string, unknown>,
        sessionId: body.sessionId ?? null,
        projectId: body.projectId ?? null,
      });
      const result = await orchestrator.analyze({
        source: body.source,
        items: body.items,
        relationType: body.relationType,
        aiStructure: body.aiStructure,
        sessionId: body.sessionId ?? null,
        projectId: body.projectId ?? null,
        forceSession: body.forceSession,
        previewOnly: body.previewOnly,
      });

      logger.info(
        {
          userId,
          workspaceId: result.workspaceId,
          source: body.source,
          mode: result.mode,
          proposalId: result.proposalId,
          sessionId: result.sessionId,
          opCount: result.operations?.length ?? 0,
        },
        "POST /import/analyze (orchestrator)"
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "POST /import/analyze failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /import/apply
   *
   * Materialize the import graph from /import/analyze (human-confirmed).
   * When proposalId is set, stored proposal ops are SSOT (HITL: preview =
   * commit); client operations optional then. Never re-structures from items.
   */
  app.post("/import/apply", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.write") &&
      !hasScope(c.get("scopes") as string[], "mcp.write")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.write or mcp.write" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ImportApplyRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      // Help clients still sending legacy { items } without operations/proposalId.
      const legacy = ImportRequestSchema.safeParse(rawBody);
      if (legacy.success) {
        return c.json(
          {
            error:
              "POST /import/apply requires `proposalId` and/or `operations` from /import/analyze (preview-before-apply). Do not re-send items alone.",
          },
          400
        );
      }
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }
    const body = parsed.data;

    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      const scopes = c.get("scopes") as string[];
      const trpcCtx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId
      );
      const orchestrator = new ImportOrchestrator({
        workspaceId: workspaceId ?? null,
        userId,
        trpcCtx: trpcCtx as unknown as Record<string, unknown>,
        sessionId: body.sessionId ?? null,
        projectId: body.projectId ?? null,
      });
      const result = await orchestrator.apply({
        source: body.source,
        // Optional when proposalId is set — orchestrator loads SSOT ops from DB.
        operations: body.operations as CompositeProposalOperation[] | undefined,
        idempotencyKey: body.idempotencyKey,
        proposalId: body.proposalId,
      });

      logger.info(
        {
          userId,
          workspaceId: result.workspaceId,
          source: body.source,
          proposalId: body.proposalId,
          created: result.created,
          linked: result.linked,
        },
        "POST /import/apply (orchestrator)"
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "POST /import/apply failed");
      // Surface BAD_REQUEST (missing/non-pending proposal, empty ops) as 400.
      const code =
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "BAD_REQUEST"
          ? 400
          : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        code
      );
    }
  });

  /**
   * POST /import/store-unit
   *
   * Bulk store-first door: create ONE entity (+ optional source-file blob) in a
   * single authenticated request. Superwhisper import was 2 Hub auth hits per
   * unit (POST /entities + POST /entities/:id/source-file), which burns the
   * per-key rate window twice as fast. This collapses to 1 hit.
   *
   * Multipart fields:
   *   title (required), content?, profileSlug? (default note), properties? (JSON),
   *   source? (cli|…), file? (optional binary provenance)
   * Omit workspaceId for pod-wide kinds (note) — entityScope decides placement.
   */
  app.post("/import/store-unit", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json(
        {
          error:
            "Content-Type must be multipart/form-data (title + optional file)",
        },
        400
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid multipart body" }, 400);
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json({ error: "title is required" }, 400);
    }
    const profileSlug =
      typeof body.profileSlug === "string" && body.profileSlug
        ? body.profileSlug
        : "note";
    const content = typeof body.content === "string" ? body.content : undefined;
    const description =
      typeof body.description === "string" ? body.description : undefined;
    const source =
      typeof body.source === "string" ? body.source : ("cli" as const);
    let properties: Record<string, unknown> = {};
    if (typeof body.properties === "string" && body.properties) {
      try {
        properties = JSON.parse(body.properties) as Record<string, unknown>;
      } catch {
        return c.json({ error: "properties must be valid JSON" }, 400);
      }
    }
    const workspaceIdField =
      typeof body.workspaceId === "string" && body.workspaceId
        ? body.workspaceId
        : undefined;
    // Item 3 Part 3: confine a bound service key to its workspace — clamp the
    // resolved workspace before it flows to the acting ctx, the createEntity
    // input, and the DIRECT storeEntitySourceBlob write below.
    const workspaceId = getConfinedWorkspace(c, workspaceIdField);

    const acting = await resolveActingContext(c, {
      workspaceId: workspaceId ?? undefined,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    // Optional binary (WAV, etc.)
    let fileBuffer: Buffer | undefined;
    let fileMime: string | undefined;
    let fileName: string | undefined;
    const file = body.file;
    if (file instanceof File) {
      if (file.size > SOURCE_BLOB_MAX_BYTES) {
        return c.json(
          {
            error: `File too large. Maximum size is ${SOURCE_BLOB_MAX_BYTES / 1024 / 1024}MB`,
          },
          413
        );
      }
      fileMime = file.type || "application/octet-stream";
      fileName = file.name || "source.bin";
      fileBuffer = Buffer.from(await file.arrayBuffer());
    }

    try {
      // Pod-wide: omit workspaceId pin so note entityScope lands null.
      const caller = await getCaller(c, {
        workspaceId: workspaceId ?? null,
        userId,
      });
      const created = await caller.entities.createEntity({
        userId,
        profileSlug,
        title,
        ...(description ? { description } : {}),
        ...(content ? { content } : {}),
        properties,
        ...(workspaceId ? { workspaceId } : {}),
        ...(source ? { source: source as "cli" } : {}),
      });

      const entityId = created.id as string;
      let audio: {
        documentId: string;
        storageKey: string;
        size: number;
        mimeType: string;
      } | null = null;
      let audioSkippedReason: string | undefined;

      if (fileBuffer && fileBuffer.length > 0 && fileMime) {
        try {
          const stored = await storeEntitySourceBlob({
            database: db,
            userId,
            entityId,
            buffer: fileBuffer,
            mimeType: fileMime,
            filename: fileName,
            workspaceId: workspaceId ?? null,
          });
          audio = {
            documentId: stored.documentId,
            storageKey: stored.storageKey,
            size: stored.size,
            mimeType: stored.mimeType,
          };
        } catch (err) {
          if (err instanceof SourceBlobTooLargeError) {
            audioSkippedReason = "over_limit";
          } else if (err instanceof SourceBlobEmptyError) {
            audioSkippedReason = "empty";
          } else {
            // Entity already created — report partial success (same as keepRaw best-effort).
            logger.warn(
              { err, entityId, userId },
              "store-unit: source blob failed (entity kept)"
            );
            audioSkippedReason = "storage_error";
          }
        }
      }

      return c.json({
        id: entityId,
        entityId,
        profileSlug,
        title,
        audio,
        audioSkippedReason: audioSkippedReason ?? null,
      });
    } catch (err) {
      logger.error({ err, userId }, "POST /import/store-unit failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /capture/graph
   *
   * Propose a whole CRM graph in ONE reviewable composite proposal — the
   * keystone of the "understand the server → propose entities + relations"
   * flow. Takes the agent's DESIGNED graph ({ entities, relations }) and creates
   * a single `import.graph` proposal whose approval materializes everything
   * atomically via materializeCompositeGraph (the exact path /import/apply uses).
   * The operator reviews + accepts ONCE instead of approving N single proposals.
   *
   * Entities may CREATE (profileSlug + title/properties) or LINK an existing
   * entity (existingEntityId) so the graph mixes new + known without duplicates.
   * Relations reference entities by their `ref` (resolved to real ids on approve).
   */
  app.post("/capture/graph", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as {
      workspaceId?: string;
      projectId?: string;
      source?: string;
      sourceMessageId?: string;
      sessionId?: string;
      rawSource?: unknown;
      entities?: Array<{
        ref: string;
        profileSlug: string;
        title?: string;
        description?: string;
        content?: string;
        properties?: Record<string, unknown>;
        existingEntityId?: string;
        facets?: Array<{
          profileSlug: string;
          status?: string;
          properties?: Record<string, unknown>;
          contextRef?: string;
        }>;
      }>;
      relations?: Array<{ sourceRef: string; targetRef: string; type: string }>;
      // Discord channel → entity bindings, applied on APPROVE (after the entities
      // materialize): each channel is bound to refToRealId[entityRef] with its
      // firewall role. Lets one accept land entities + relations + channel binds.
      bindings?: Array<{
        externalChannelId: string;
        entityRef: string;
        branchPurpose?: "client-comms" | "team";
        title?: string;
      }>;
      summary?: string;
    } | null;

    if (!body || !Array.isArray(body.entities) || body.entities.length === 0) {
      return c.json({ error: "entities[] is required (at least one)" }, 400);
    }
    if (
      body.source &&
      !GRAPH_WRITE_SOURCES.has(body.source as GraphWriteSource)
    ) {
      return c.json({ error: "Unsupported graph write source" }, 400);
    }
    if (
      body.projectId &&
      !z.string().uuid().safeParse(body.projectId).success
    ) {
      return c.json({ error: "projectId must be a UUID" }, 400);
    }
    const rawSource =
      body.rawSource === undefined
        ? undefined
        : CaptureGraphRawSourceSchema.safeParse(body.rawSource);
    if (rawSource && !rawSource.success) {
      return c.json(
        {
          error: "Invalid rawSource proposal provenance",
          details: rawSource.error.issues,
        },
        400
      );
    }
    // This is a governed graph proposal, but its workspace still sets the
    // proposal's audience and approval surface. Bind it to the authenticated
    // principal and membership-check the requested workspace before accepting
    // any graph refs; otherwise an API key could queue work in a foreign lens.
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;
    // Entity ref + profileSlug presence stays door-local (REST requires both
    // together); the ref set built here also feeds the binding check below.
    const refs = new Set<string>();
    for (const e of body.entities) {
      if (!e.ref || !e.profileSlug) {
        return c.json(
          { error: "each entity needs a `ref` and a `profileSlug`" },
          400
        );
      }
      refs.add(e.ref);
    }
    let relations = Array.isArray(body.relations) ? body.relations : [];
    // SHARED: ref-uniqueness + dangling-relation (fail loud — a dangling ref
    // would silently drop the link at materialization time). Rendered with this
    // door's exact wording + 400 shape.
    const refIssue = validateCaptureGraphRefs(body.entities, relations);
    if (refIssue) {
      return c.json(
        {
          error:
            refIssue.kind === "duplicate-ref"
              ? `duplicate entity ref: ${refIssue.ref}`
              : `relation references an unknown ref: ${refIssue.sourceRef} -> ${refIssue.targetRef}`,
        },
        400
      );
    }
    let bindings = Array.isArray(body.bindings) ? body.bindings : [];
    for (const b of bindings) {
      if (!b.externalChannelId || !b.entityRef) {
        return c.json(
          { error: "each binding needs `externalChannelId` and `entityRef`" },
          400
        );
      }
      if (!refs.has(b.entityRef)) {
        return c.json(
          { error: `binding references an unknown entity ref: ${b.entityRef}` },
          400
        );
      }
    }

    try {
      // The within-batch dedup, persisted-entity dedup, operations build, and
      // event-backed proposal all live in the shared core so in-process
      // producers (Cal.com webhook/backfill) go through the SAME door path.
      const result = await submitCaptureGraph({
        userId,
        workspaceId,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.source ? { source: body.source as GraphWriteSource } : {}),
        ...(body.sourceMessageId
          ? { sourceMessageId: body.sourceMessageId }
          : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(rawSource?.success ? { rawSource: rawSource.data } : {}),
        entities: body.entities,
        relations,
        bindings,
        summary: body.summary,
      });
      logger.info(
        {
          userId,
          workspaceId,
          entityCount: result.entityCount,
          relationCount: result.relationCount,
          proposalId: result.proposalId,
        },
        "POST /capture/graph"
      );
      return c.json(result);
    } catch (err) {
      // Missing-required-property preflight rejection → 400 (client input fault),
      // message preserved. Nothing was queued.
      if (err instanceof CaptureGraphValidationError) {
        return c.json({ error: err.message }, 400);
      }
      logger.error({ err, userId }, "POST /capture/graph failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
