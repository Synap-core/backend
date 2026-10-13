/**
 * Import → Curate → Build — the `import.*` procedures of a metadata-first
 * import (spread into the `import` router, `routers/import.ts`).
 *
 * Every procedure is OWNER-FLOORED: the import is a focus session the caller
 * owns; a foreign or missing id reads NOT_FOUND. The logic lives in
 * `services/imports/*` — one module per step; these are thin doors.
 *
 *   stage      open (or append to) an import; stage items without reading them
 *   list       the caller's open imports, newest first
 *   get        one import: phase, groups, items (paged), counts
 *   group      one AI pass over titles → groups (deterministic fallback, said)
 *   curate     notes, decisions, membership — atomically
 *   attachFile the bytes for an item the pod must not scrape
 *   build      one group → one governed bundle
 *   discard    drop the never-built items and close the import
 */

import { z } from "zod";
import { podProcedure } from "../trpc.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import { requireUserId } from "../utils/user-scoped.js";
import { db } from "@synap/database";
import {
  IMPORT_GROUP_OUTPUTS,
  IMPORT_ITEM_DECISIONS,
  IMPORT_LIMITS,
  type ImportBuildResult,
  type ImportCurateOp,
  type ImportGroupResult,
  type ImportItemView,
  type ImportListEntry,
  type ImportStageItemInput,
  type ImportStageResult,
  type ImportView,
} from "@synap-core/types/imports";
import {
  assertImportOpen,
  listOpenImportSessions,
  loadImportSession,
  openImportSession,
} from "../services/imports/session.js";
import {
  buildImportView,
  countImportItems,
} from "../services/imports/read-model.js";
import { stageImportItems } from "../services/imports/stage.js";
import { groupImport } from "../services/imports/group.js";
import { curateImport } from "../services/imports/curate.js";
import { attachImportItemFile } from "../services/imports/attach.js";
import {
  buildImportGroup,
  defaultImportBuildDeps,
} from "../services/imports/build.js";
import { discardImport } from "../services/imports/discard.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const L = IMPORT_LIMITS;
/** Base64 grows bytes by 4/3; a little slack for padding. */
const INLINE_BASE64_MAX = Math.ceil((L.inlineFileBytesMax * 4) / 3) + 8;

const itemNote = z.string().max(L.itemNoteMax).optional();

export const ImportStageItemSchema: z.ZodType<ImportStageItemInput> =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("url"),
      url: z.string().min(1).max(4000),
      title: z.string().max(500).optional(),
      note: itemNote,
      /** The page as the browser rendered it (a login-only page). */
      html: z.string().max(L.pageHtmlMax).optional(),
    }),
    z.object({
      kind: z.literal("text"),
      text: z.string().min(1).max(200_000),
      title: z.string().max(500).optional(),
      note: itemNote,
    }),
    z.object({
      kind: z.literal("file"),
      filename: z.string().min(1).max(500),
      mimeType: z.string().min(1).max(200),
      documentId: z.string().uuid().optional(),
      contentBase64: z.string().max(INLINE_BASE64_MAX).optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      sha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional(),
      note: itemNote,
    }),
  ]);

const groupKey = z.string().min(1).max(64);
const itemIds = z.array(z.string().uuid()).min(1).max(L.itemsMax);

export const ImportCurateOpSchema: z.ZodType<ImportCurateOp> =
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("setGroupNote"),
      groupKey,
      note: z.string().max(L.groupNoteMax),
    }),
    z.object({
      op: z.literal("setGroupOutputs"),
      groupKey,
      outputs: z
        .array(z.enum(IMPORT_GROUP_OUTPUTS))
        .max(IMPORT_GROUP_OUTPUTS.length),
    }),
    z.object({
      op: z.literal("renameGroup"),
      groupKey,
      name: z.string().min(1).max(L.groupNameMax),
    }),
    z.object({
      op: z.literal("createGroup"),
      name: z.string().min(1).max(L.groupNameMax),
      itemIds: z.array(z.string().uuid()).max(L.itemsMax).optional(),
    }),
    z.object({
      op: z.literal("mergeGroups"),
      fromKey: groupKey,
      intoKey: groupKey,
    }),
    z.object({ op: z.literal("deleteGroup"), groupKey }),
    z.object({ op: z.literal("addToGroup"), groupKey, itemIds }),
    z.object({ op: z.literal("removeFromGroup"), groupKey, itemIds }),
    z.object({
      op: z.literal("setItemNote"),
      itemId: z.string().uuid(),
      note: z.string().max(L.itemNoteMax),
    }),
    z.object({
      op: z.literal("setDecision"),
      itemIds,
      decision: z.enum(IMPORT_ITEM_DECISIONS),
    }),
  ]);

const sessionId = z.string().uuid();

// ─── Procedures ─────────────────────────────────────────────────────────────

export const importCurateProcedures = {
  /** Open an import (phase `collecting`) when `sessionId` is absent, else append. */
  stage: podProcedure
    .input(
      z.object({
        sessionId: sessionId.optional(),
        title: z.string().max(200).optional(),
        origin: z.string().max(40).optional(),
        workspaceId: z.string().uuid().nullish(),
        projectId: z.string().uuid().nullish(),
        items: z.array(ImportStageItemSchema).min(1).max(L.stageBatchMax),
      })
    )
    .mutation(async ({ ctx, input }): Promise<ImportStageResult> => {
      const userId = requireUserId(ctx.userId);
      let id = input.sessionId;
      if (!id) {
        const opened = await openImportSession({
          userId,
          agentUserId: ctx.agentUserId ?? null,
          workspaceId: input.workspaceId ?? ctx.workspaceId ?? null,
          projectId: input.projectId ?? null,
          title: input.title ?? null,
          origin: input.origin ?? null,
        });
        id = opened.sessionId;
      }
      const session = await loadImportSession({ userId, sessionId: id });
      assertImportOpen(session);
      const outcome = await stageImportItems({
        userId,
        session,
        items: input.items,
      });
      return { sessionId: session.id, ...outcome };
    }),

  /** The caller's open imports, newest first. */
  list: podProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(50).default(10) })
        .default({ limit: 10 })
    )
    .query(async ({ ctx, input }): Promise<{ imports: ImportListEntry[] }> => {
      const userId = requireUserId(ctx.userId);
      const sessions = await listOpenImportSessions({
        userId,
        limit: input.limit,
      });
      const imports = await Promise.all(
        sessions.map(async (session) => ({
          sessionId: session.id,
          title: session.title,
          phase: session.curation.phase,
          ...(session.curation.origin
            ? { origin: session.curation.origin }
            : {}),
          counts: await countImportItems({ database: db, userId, session }),
          updatedAt: session.updatedAt.toISOString(),
        }))
      );
      return { imports };
    }),

  /** One import: phase, groups, items (paged in staging order), counts. */
  get: podProcedure
    .input(
      z.object({
        sessionId,
        cursor: z.string().max(500).nullish(),
        limit: z.number().int().min(1).max(500).optional(),
      })
    )
    .query(async ({ ctx, input }): Promise<ImportView> => {
      const userId = requireUserId(ctx.userId);
      const session = await loadImportSession({
        userId,
        sessionId: input.sessionId,
      });
      return buildImportView({
        database: db,
        userId,
        session,
        cursor: input.cursor ?? null,
        ...(input.limit ? { limit: input.limit } : {}),
      });
    }),

  /** One AI pass over titles → groups. Deterministic fallback is SAID. */
  group: podProcedure
    .use(aiRateLimitMiddleware)
    .input(z.object({ sessionId }))
    .mutation(async ({ ctx, input }): Promise<ImportGroupResult> => {
      const userId = requireUserId(ctx.userId);
      const { generateViaIS } =
        await import("../services/mail-feed/generate.js");
      const result = await groupImport({
        userId,
        sessionId: input.sessionId,
        generate: (args) => generateViaIS(args),
      });
      const session = await loadImportSession({
        userId,
        sessionId: input.sessionId,
      });
      const view = await buildImportView({ database: db, userId, session });
      return { ...view, groupingDegraded: result.groupingDegraded };
    }),

  /** Apply the person's edits atomically. */
  curate: podProcedure
    .input(
      z.object({
        sessionId,
        ops: z.array(ImportCurateOpSchema).min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }): Promise<ImportView> => {
      const userId = requireUserId(ctx.userId);
      await curateImport({
        userId,
        sessionId: input.sessionId,
        ops: input.ops,
      });
      const session = await loadImportSession({
        userId,
        sessionId: input.sessionId,
      });
      return buildImportView({ database: db, userId, session });
    }),

  /** The bytes Build needs for an item (a `needs_file` reel, …). */
  attachFile: podProcedure
    .input(
      z
        .object({
          sessionId,
          itemId: z.string().uuid(),
          filename: z.string().min(1).max(500),
          mimeType: z.string().min(1).max(200),
          documentId: z.string().uuid().optional(),
          contentBase64: z.string().max(INLINE_BASE64_MAX).optional(),
        })
        .refine((v) => Boolean(v.documentId) !== Boolean(v.contentBase64), {
          message: "Send exactly one of documentId or contentBase64",
        })
    )
    .mutation(async ({ ctx, input }): Promise<ImportItemView> => {
      const userId = requireUserId(ctx.userId);
      return attachImportItemFile({ userId, ...input });
    }),

  /** One group → one governed bundle. `proposed` is success. */
  build: podProcedure
    .use(aiRateLimitMiddleware)
    .input(z.object({ sessionId, groupKey }))
    .mutation(async ({ ctx, input }): Promise<ImportBuildResult> => {
      const userId = requireUserId(ctx.userId);
      const session = await loadImportSession({
        userId,
        sessionId: input.sessionId,
      });
      return buildImportGroup({
        userId,
        sessionId: input.sessionId,
        groupKey: input.groupKey,
        deps: defaultImportBuildDeps({
          userId,
          workspaceId: session.workspaceId,
          trpcCtx: ctx as unknown as Record<string, unknown>,
        }),
      });
    }),

  /** Drop the never-built items and close the import. */
  discard: podProcedure
    .input(z.object({ sessionId }))
    .mutation(async ({ ctx, input }): Promise<{ discarded: number }> => {
      const userId = requireUserId(ctx.userId);
      return discardImport({
        userId,
        agentUserId: ctx.agentUserId ?? null,
        sessionId: input.sessionId,
      });
    }),
};
