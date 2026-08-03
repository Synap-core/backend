/**
 * Import Router
 *
 * Bulk import of user data: JSON → channels/messages, Markdown → entities (+ optional docs),
 * CSV → entities (with optional profile creation). Other files stored only.
 * Reuses documents.upload, entities.create, chat.createExternalChannel + message insert.
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import { createLogger } from "@synap-core/core";
import { ImportOrchestrator } from "../services/import-orchestrator.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { getBoss } from "@synap/jobs";
import { IMPORT_CORPUS_QUEUE } from "@synap/jobs/workers/import-corpus-worker.js";

const logger = createLogger({ module: "import-router" });

// ─── Schemas ─────────────────────────────────────────────────────────────────
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
  // Pre-existing focus session to attach this import's proposals to. Omitted →
  // analyze may mint an Import session (N≥2 or forceSession) and returns its id.
  sessionId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullish(),
  /** Force mint Import session even when N&lt;2. */
  forceSession: z.boolean().optional(),
  // Playbook to template the import session from. When present, analyze()
  // instantiates a playbook-templated session (goal, expectedOutputs, playbookId
  // FK, instantiated_from link) instead of a bare Import session.
  playbookId: z.string().uuid().optional(),
  playbookParams: z.record(z.string(), z.string()).optional(),
  /**
   * Structure only — no durable import.graph proposal (CLI --dry-run).
   * Prevents inbox spam from preview/analyze loops.
   */
  previewOnly: z.boolean().optional(),
});

const applyImportOpsOrProposal = (
  v: { operations?: unknown[]; proposalId?: string },
  ctx: z.RefinementCtx
) => {
  const hasOps = Array.isArray(v.operations) && v.operations.length > 0;
  if (!hasOps && !v.proposalId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Either operations (min 1) or proposalId is required (proposal is SSOT for ops when set)",
      path: ["operations"],
    });
  }
};

const ApplyImportBaseSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  source: RevealSource,
  // Ops echoed from analyze. Optional when proposalId is set — the stored
  // proposal is SSOT for ops (HITL: preview = commit). Required when no proposalId.
  operations: z.array(z.record(z.string(), z.unknown())).max(8000).optional(),
  // Client-stable idempotency namespace (U1). Prefer the analyze proposalId.
  // When omitted, server derives a stable key (proposalId field or op-ref hash).
  idempotencyKey: z.string().max(200).optional(),
  // Analyze proposal id — SSOT for ops when present; default idempotencyKey.
  proposalId: z.string().uuid().optional(),
  // Session this apply's writes belong to (the id returned by analyze). Threaded
  // onto the orchestrator so the import groups under its session. Optional.
  sessionId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullish(),
});

const ApplyImportSchema = ApplyImportBaseSchema.superRefine(
  applyImportOpsOrProposal
);

// Large (chunked) variants — same shape as analyze/apply with raised ceilings.
// The orchestrator splits the corpus into chunks internally while preserving
// cross-chunk dedup. These run SYNCHRONOUSLY in one request today, so the
// ceilings are deliberately bounded (not "no cap") to keep wall-clock + body
// size sane until a pg-boss-backed worker streams them as a background job
// (see UI-CONSOLIDATION-PLAN.md → large-import). An aggregate byte budget
// mirrors submitBatch's MAX_BATCH_BYTES, scaled.
const MAX_LARGE_CONTENT_BYTES = 48 * 1024 * 1024; // 48MB total text/request

/**
 * Exported so the Hub REST door (`POST /import/enqueue-corpus`) validates the
 * SAME shape as the tRPC procedures rather than re-declaring the item caps and
 * the aggregate byte budget — two copies would drift.
 */
export const AnalyzeLargeImportSchema = AnalyzeImportSchema.extend({
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

const ApplyLargeImportSchema = ApplyImportBaseSchema.extend({
  operations: z.array(z.record(z.string(), z.unknown())).max(25_000).optional(),
}).superRefine(applyImportOpsOrProposal);

// ─── Router ─────────────────────────────────────────────────────────────────

export const importRouter = router({
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
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        playbookId: input.playbookId ?? null,
      });
      return orchestrator.analyze({
        source: input.source,
        items: input.items,
        relationType: input.relationType,
        aiStructure: input.aiStructure,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        forceSession: input.forceSession,
        playbookId: input.playbookId ?? null,
        playbookParams: input.playbookParams,
        previewOnly: input.previewOnly,
      });
    }),

  /**
   * Materialize the previewed graph. When `proposalId` is set the stored
   * proposal ops are SSOT (HITL); otherwise client-echoed `operations` from
   * analyze are required. User-confirmed direct write (preview was the review).
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
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
      });
      return orchestrator.apply({
        source: input.source,
        operations: input.operations as
          CompositeProposalOperation[] | undefined,
        idempotencyKey: input.idempotencyKey,
        proposalId: input.proposalId,
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
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
      });
      return orchestrator.analyzeLarge({
        source: input.source,
        items: input.items,
        relationType: input.relationType,
        aiStructure: input.aiStructure,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        previewOnly: input.previewOnly,
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
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
      });
      return orchestrator.applyLarge({
        source: input.source,
        operations: input.operations as
          CompositeProposalOperation[] | undefined,
        idempotencyKey: input.idempotencyKey,
        proposalId: input.proposalId,
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
});
