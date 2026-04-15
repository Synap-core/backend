/**
 * Import Router
 *
 * Bulk import of user data: JSON → channels/messages, Markdown → entities (+ optional docs),
 * CSV → entities (with optional profile creation). Other files stored only.
 * Reuses documents.upload, entities.create, chat.createExternalChannel + message insert.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { ImportOrchestrator } from "../services/import-orchestrator.js";

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

  // ─── Telegram contacts bulk import ──────────────────────────────────────────

  /**
   * Queue a batch of Telegram contacts for server-side entity creation.
   *
   * The client (relay-app, browser) parses the Telegram Desktop JSON export
   * and sends the contact list here. Heavy entity creation + dedup runs
   * asynchronously via pg-boss so the HTTP request returns immediately.
   *
   * Returns a job ID — clients can poll background-tasks for progress.
   */
  telegramContacts: workspaceProcedure
    .input(
      z.object({
        people: z
          .array(
            z.object({
              externalId: z.string().min(1),
              name: z.string().min(1).max(500),
              phone: z.string().nullable().optional(),
              username: z.string().nullable().optional(),
              messageCount: z.number().int().nonnegative().optional(),
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
      const result = await orchestrator.queueTelegramContacts(input.people);
      logger.info(
        {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          queuedCount: input.people.length,
          ...result,
        },
        "Telegram bulk import job queued via orchestrator"
      );
      return result;
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
