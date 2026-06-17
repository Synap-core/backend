/**
 * Import Router
 *
 * Bulk import of user data: JSON → channels/messages, Markdown → entities (+ optional docs),
 * CSV → entities (with optional profile creation). Other files stored only.
 * Reuses documents.upload, entities.create, chat.createExternalChannel + message insert.
 */

import { z } from "zod";
import {
  router,
  workspaceProcedure,
  protectedProcedure,
  podProcedure,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { ImportOrchestrator } from "../services/import-orchestrator.js";
import { EventNames } from "@synap-core/types/events";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { getBoss } from "@synap/jobs";
import { IMPORT_CORPUS_QUEUE } from "@synap/jobs/workers/import-corpus-worker.js";

const logger = createLogger({ module: "import-router" });

// ─── Schemas ─────────────────────────────────────────────────────────────────
const ImportItemSchema = z.object({
  path: z.string().min(1).max(512),
  contentBase64: z.string(),
  mimeType: z.string().optional(),
});

const SubmitBatchSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  items: z.array(ImportItemSchema).min(1).max(50),
});

// Preview-before-apply (the in-app import "reveal"). Raw text items (not base64)
// — markdown/obsidian/csv/bookmark — structured into a composite graph the user
// reviews inline, then materializes by echoing back the SAME operations.
const RevealSource = z.enum(["obsidian", "markdown", "csv", "bookmark"]);

const AnalyzeImportSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  source: RevealSource,
  items: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        content: z.string().max(200_000),
      })
    )
    .min(1)
    .max(2000),
  relationType: z.string().min(1).max(64).optional(),
  aiStructure: z.boolean().optional().default(true),
});

const ApplyImportSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  source: RevealSource,
  // The exact operations returned by `analyze` — echoed back so what the user
  // previewed is what is created (no server re-structuring drift).
  operations: z.array(z.record(z.string(), z.unknown())).max(8000),
  // Client-stable idempotency namespace (U1). When supplied (e.g. the analyze
  // proposalId), a retry of this apply with the SAME key links the entities it
  // already created instead of duplicating them. Absent → unchanged behavior.
  idempotencyKey: z.string().max(200).optional(),
});

// Large (chunked) variants — same shape as analyze/apply with raised ceilings.
// The orchestrator splits the corpus into chunks internally while preserving
// cross-chunk dedup. These run SYNCHRONOUSLY in one request today, so the
// ceilings are deliberately bounded (not "no cap") to keep wall-clock + body
// size sane until a pg-boss-backed worker streams them as a background job
// (see UI-CONSOLIDATION-PLAN.md → large-import). An aggregate byte budget
// mirrors submitBatch's MAX_BATCH_BYTES, scaled.
const MAX_LARGE_CONTENT_BYTES = 48 * 1024 * 1024; // 48MB total text/request

const AnalyzeLargeImportSchema = AnalyzeImportSchema.extend({
  items: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        content: z.string().max(200_000),
      })
    )
    .min(1)
    .max(4_000)
    .superRefine((items, ctx) => {
      const bytes = items.reduce((sum, it) => sum + it.content.length, 0);
      if (bytes > MAX_LARGE_CONTENT_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Import too large (${Math.round(bytes / 1024 / 1024)}MB). Split it into smaller batches (max ${MAX_LARGE_CONTENT_BYTES / 1024 / 1024}MB).`,
        });
      }
    }),
});

const ApplyLargeImportSchema = ApplyImportSchema.extend({
  operations: z.array(z.record(z.string(), z.unknown())).max(25_000),
});

// ─── Router ─────────────────────────────────────────────────────────────────

export const importRouter = router({
  submitBatch: workspaceProcedure
    .input(SubmitBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace ID required. Set X-Workspace-Id or pass workspaceId.",
        });
      }
      const orchestrator = new ImportOrchestrator({
        workspaceId,
        userId: ctx.userId as string,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      return orchestrator.submitBatch(input.items);
    }),

  /**
   * Preview the structured import graph WITHOUT writing entities. Returns the
   * composite operations (so the client renders the CompositeProposalGraph
   * reveal inline) plus a governed `import.graph` proposal id. Pair with `apply`.
   */
  analyze: podProcedure
    .input(AnalyzeImportSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      const orchestrator = new ImportOrchestrator({
        workspaceId,
        userId: ctx.userId as string,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      return orchestrator.analyze({
        source: input.source,
        items: input.items,
        relationType: input.relationType,
        aiStructure: input.aiStructure,
      });
    }),

  /**
   * Materialize the previewed graph: takes the exact `operations` from `analyze`
   * and creates entities + relations, workspace-scoped. User-confirmed direct
   * write of their own data (the preview was the review).
   */
  // NOTE: must NOT be named `apply` — tRPC v11.17+ rejects reserved words
  // (Function.prototype.apply) as procedure keys and refuses to build the router.
  applyImport: podProcedure
    .input(ApplyImportSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      const orchestrator = new ImportOrchestrator({
        workspaceId,
        userId: ctx.userId as string,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      return orchestrator.apply({
        source: input.source,
        operations: input.operations as unknown as CompositeProposalOperation[],
        idempotencyKey: input.idempotencyKey,
      });
    }),

  /**
   * Large-corpus variant of `analyze`: chunks the items internally (cross-chunk
   * dedup preserved via a shared graph resolver) so an arbitrarily large prose
   * import produces ONE governed `import.graph` proposal without hitting the
   * per-call deep ceiling. Returns the same shape family as `analyze`.
   */
  analyzeLarge: podProcedure
    .input(AnalyzeLargeImportSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      const orchestrator = new ImportOrchestrator({
        workspaceId,
        userId: ctx.userId as string,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      return orchestrator.analyzeLarge({
        source: input.source,
        items: input.items,
        relationType: input.relationType,
        aiStructure: input.aiStructure,
      });
    }),

  /**
   * Background variant of `analyzeLarge`: enqueues the corpus onto the
   * `import-corpus` pg-boss queue and returns immediately. The worker runs
   * `ImportOrchestrator.analyzeLarge` server-side, producing ONE governed
   * `import.graph` proposal — so very large imports no longer block the HTTP
   * request. The handler that runs analyzeLarge is wired at api boot (IoC), so
   * the jobs package never imports the orchestrator.
   */
  enqueueLargeImport: podProcedure
    .input(AnalyzeLargeImportSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      const jobId = await getBoss().send(IMPORT_CORPUS_QUEUE, {
        userId: ctx.userId as string,
        workspaceId,
        source: input.source,
        items: input.items,
      });
      logger.info(
        {
          workspaceId,
          userId: ctx.userId,
          source: input.source,
          itemCount: input.items.length,
          jobId,
        },
        "Large import enqueued on import-corpus queue"
      );
      return { queued: true as const, jobId };
    }),

  /**
   * Large-corpus variant of `applyImport`: chunks the operations internally
   * (cumulative ref→id map carried across chunks so cross-chunk relations
   * resolve) and materializes them workspace-scoped. Same auth/workspace pattern
   * as `applyImport`.
   */
  applyLarge: podProcedure
    .input(ApplyLargeImportSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      const orchestrator = new ImportOrchestrator({
        workspaceId,
        userId: ctx.userId as string,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      return orchestrator.applyLarge({
        source: input.source,
        operations: input.operations as unknown as CompositeProposalOperation[],
        idempotencyKey: input.idempotencyKey,
      });
    }),

  // ─── LinkedIn connections bulk import ───────────────────────────────────────

  /**
   * Queue a batch of LinkedIn connections for server-side entity creation.
   *
   * The client parses the LinkedIn Connections.csv and sends the contact list
   * here. Heavy entity creation + dedup runs asynchronously via pg-boss so
   * the HTTP request returns immediately.
   */
  linkedInContacts: workspaceProcedure
    .input(
      z.object({
        contacts: z
          .array(
            z.object({
              externalId: z.string().min(1),
              name: z.string().min(1).max(500),
              email: z.string().nullable().optional(),
              company: z.string().nullable().optional(),
              role: z.string().nullable().optional(),
              connectedOn: z.string().nullable().optional(),
            })
          )
          .min(1)
          .max(5000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const orchestrator = new ImportOrchestrator({
        workspaceId: ctx.workspaceId!,
        userId: ctx.userId!,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      const result = await orchestrator.queueLinkedInContacts(input.contacts);
      logger.info(
        {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          queuedCount: input.contacts.length,
          ...result,
        },
        "LinkedIn bulk import job queued via orchestrator"
      );
      return result;
    }),

  previewModeling: workspaceProcedure
    .input(
      z.object({
        source: z.enum([
          "csv",
          "json",
          "markdown",
          "bookmarks_html",
          "contacts_device",
          "telegram_archive",
          "linkedin_archive",
          "connector_sync",
          "local_migration",
        ]),
        sampleRows: z.array(z.record(z.string(), z.unknown())).max(200),
      })
    )
    .query(async ({ ctx, input }) => {
      const orchestrator = new ImportOrchestrator({
        workspaceId: ctx.workspaceId!,
        userId: ctx.userId!,
        trpcCtx: ctx as unknown as Record<string, unknown>,
      });
      return orchestrator.previewModeling(input.sampleRows, input.source);
    }),

  /**
   * Returns the Socket.IO event name and room descriptor for import batch
   * progress events. No DB access — pure contract documentation for clients.
   *
   * Usage pattern:
   *   1. Call `trpc.import.batchProgressRoom()` to get the event name + room.
   *   2. Subscribe to `socket.on(event, handler)` filtered by your `batchId`.
   *   3. Call `trpc.import.submitBatch({ items })` — the returned `batchId`
   *      matches what arrives in each progress event payload.
   *
   * Events arrive in the caller's user room automatically; no extra join needed.
   */
  batchProgressRoom: protectedProcedure.query(({ ctx }) => ({
    event: EventNames.IMPORT_FILE_PROGRESS,
    room: `user:${ctx.userId}`,
    description:
      "Listen to this Socket.IO event on your user room. Filter by batchId from submitBatch.",
  })),
});
