/**
 * `library.*` — the Library: everything the person KEEPS (CAPTURE_LIBRARY_PLAN
 * L2). Thin doors over `services/library/*`; every procedure is OWNER-FLOORED
 * (a foreign or missing id reads NOT_FOUND) and Zod-validated.
 *
 *   add        keep items (appends to the open "Kept from <device>, <day>" run);
 *              a share-time note becomes a Capture; optional Read now (1 item)
 *   list       items, newest first, keyset-paged; lens + status + group + text
 *   groups     every live group with counts, plus ungrouped / archived counts
 *   group      one group + the first page of its items
 *   curate     groups, membership, decisions, notes, suggestions, archive — atomic
 *   search     ONE search over captures (your words) and the Library
 *   readNow    one item structured now (governed), filed alone
 *   runAction  run one suggested chip as ONE governed proposal
 *   build      a group → one governed bundle (first build or rebuild)
 *   health     unread / groups waiting / oldest wait (orient)
 *
 * The AI's capture door (MCP `synap_capture`) is untouched and never lands
 * here. AI-spending doors (`readNow`, `build`, `add` with readNow) pass the AI
 * rate limiter.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db } from "@synap/database";
import { router, podProcedure } from "../trpc.js";
import {
  aiRateLimitMiddleware,
  assertAiRateLimit,
} from "../middleware/ai-rate-limit.js";
import type { Context } from "../types/context.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  IMPORT_GROUP_OUTPUTS,
  IMPORT_ITEM_DECISIONS,
  IMPORT_LIMITS,
  LIBRARY_LIMITS,
  LIBRARY_READ_STATUSES,
  type ImportBuildResult,
  type LibraryAddResult,
  type LibraryCurateOp,
  type LibraryCurateResult,
  type LibraryGroupResult,
  type LibraryGroupsResult,
  type LibraryHealth,
  type LibraryListResult,
  type LibraryRunActionResult,
  type LibrarySearchResult,
} from "@synap-core/types/imports";
import { ImportStageItemSchema, personProcedure } from "./library-shared.js";
import { defaultImportBuildDeps } from "../services/imports/build.js";
import { addToLibrary } from "../services/library/add.js";
import { listLibraryItems } from "../services/library/read-model.js";
import {
  adoptImportGroups,
  groupViews,
  loadLibraryGroup,
  readLibraryGroups,
} from "../services/library/groups.js";
import { curateLibrary } from "../services/library/curate.js";
import {
  LibraryActionError,
  runLibraryAction,
} from "../services/library/run-action.js";
import { libraryHealth, searchLibrary } from "../services/library/search.js";
import {
  buildLibraryGroup,
  readNowLibraryItem,
} from "../services/library/build.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const L = IMPORT_LIMITS;
const uuid = z.string().uuid();
const ids = z.array(uuid).min(1).max(L.itemsMax);
const optIds = z.array(uuid).max(L.itemsMax).optional();
const groupName = z.string().min(1).max(L.groupNameMax);
const groupNote = z.string().max(L.groupNoteMax);

export const LibraryCurateOpSchema: z.ZodType<LibraryCurateOp> =
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("group.create"),
      name: groupName,
      note: groupNote.optional(),
      itemIds: optIds,
    }),
    z.object({
      op: z.literal("group.update"),
      groupId: uuid,
      name: groupName.optional(),
      note: groupNote.optional(),
      outputs: z
        .array(z.enum(IMPORT_GROUP_OUTPUTS))
        .max(IMPORT_GROUP_OUTPUTS.length)
        .optional(),
      /** Build target space; null clears it. Writability checked in curate. */
      workspaceId: uuid.nullable().optional(),
    }),
    z.object({ op: z.literal("group.archive"), groupId: uuid }),
    z.object({ op: z.literal("group.merge"), fromId: uuid, intoId: uuid }),
    z.object({
      op: z.literal("group.items"),
      groupId: uuid,
      add: optIds,
      remove: optIds,
    }),
    z.object({
      op: z.literal("item.decide"),
      itemIds: ids,
      decision: z.enum(IMPORT_ITEM_DECISIONS),
    }),
    z.object({
      op: z.literal("item.note"),
      itemId: uuid,
      note: z.string().max(L.itemNoteMax),
    }),
    z.object({
      op: z.literal("item.groups"),
      itemId: uuid,
      add: optIds,
      remove: optIds,
    }),
    z.object({
      op: z.literal("suggestion.accept"),
      itemId: uuid,
      groupId: uuid,
    }),
    z.object({
      op: z.literal("suggestion.dismiss"),
      itemId: uuid,
      groupId: uuid,
    }),
    z.object({ op: z.literal("item.archive"), itemIds: ids }),
    z.object({ op: z.literal("item.unarchive"), itemIds: ids }),
    z.object({ op: z.literal("item.delete"), itemIds: ids }),
    z.object({ op: z.literal("item.restore"), itemIds: ids }),
    z.object({ op: z.literal("item.seen"), itemIds: ids }),
    z.object({ op: z.literal("group.unarchive"), groupId: uuid }),
  ]);

export const LibraryAddInputSchema = z
  .object({
    items: z
      .array(ImportStageItemSchema)
      .min(1)
      .max(LIBRARY_LIMITS.addBatchMax),
    note: z.string().max(LIBRARY_LIMITS.shareNoteMax).optional(),
    readNow: z.boolean().optional(),
    workspaceId: uuid.optional(),
    projectId: uuid.optional(),
    device: z.string().max(40).optional(),
    captureNoteId: uuid.optional(),
  })
  .refine((v) => !v.readNow || v.items.length === 1, {
    message: "Read now applies to one item at a time.",
    path: ["readNow"],
  });

export const LibraryListInputSchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(LIBRARY_LIMITS.pageMax).optional(),
  groupId: z.union([uuid, z.literal("ungrouped")]).optional(),
  status: z.enum(LIBRARY_READ_STATUSES).optional(),
  archived: z.boolean().optional(),
  workspaceId: uuid.optional(),
  projectId: uuid.optional(),
  q: z.string().max(200).optional(),
});

export const LibrarySearchInputSchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(20),
});

// ─── Build deps ─────────────────────────────────────────────────────────────

function depsFor(ctx: Context, userId: string) {
  return (run: { workspaceId: string | null }) =>
    defaultImportBuildDeps({
      userId,
      workspaceId: run.workspaceId,
      trpcCtx: { ...ctx },
    });
}

/** THE Read now door, shared by `readNow` and `add({ readNow })`. */
async function readNowDoor(
  ctx: Context,
  userId: string,
  itemId: string
): Promise<ImportBuildResult> {
  return readNowLibraryItem({ userId, itemId, depsFor: depsFor(ctx, userId) });
}

/** One chip → one governed proposal (`services/library/run-action.ts`). */
async function runLibraryActionDoor(args: {
  userId: string;
  itemId: string;
  actionId: string;
}): Promise<LibraryRunActionResult> {
  try {
    return await runLibraryAction({ database: db, ...args });
  } catch (err) {
    if (err instanceof LibraryActionError) {
      throw new TRPCError({
        code: err.code === "IN_FLIGHT" ? "CONFLICT" : "NOT_FOUND",
        message: err.message,
      });
    }
    throw err;
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export const libraryRouter = router({
  /** Keep items. `proposed` / staged is success; a refused item names its index. */
  add: personProcedure
    .input(LibraryAddInputSchema)
    .mutation(async ({ ctx, input }): Promise<LibraryAddResult> => {
      const userId = requireUserId(ctx.userId);
      const result = await addToLibrary({
        userId,
        request: input,
        workspaceId: ctx.workspaceId ?? null,
        ...(input.readNow
          ? {
              // Counted by the same AI rate limit as the `readNow` door.
              readNow: async (itemId: string) => {
                assertAiRateLimit(userId);
                const r = await readNowDoor(ctx, userId, itemId);
                return r.status === "refused"
                  ? { refused: r.reason ?? "refused" }
                  : r.proposalId
                    ? { proposalId: r.proposalId }
                    : {};
              },
            }
          : {}),
      });
      return result;
    }),

  /** Items, newest first. */
  list: podProcedure
    .input(LibraryListInputSchema.default({}))
    .query(async ({ ctx, input }): Promise<LibraryListResult> => {
      const userId = requireUserId(ctx.userId);
      await adoptImportGroups({ userId });
      return listLibraryItems({ userId, input });
    }),

  /** Every live group with counts. */
  groups: podProcedure
    .input(
      z
        .object({ workspaceId: uuid.optional(), projectId: uuid.optional() })
        .default({})
    )
    .query(async ({ ctx, input }): Promise<LibraryGroupsResult> => {
      const userId = requireUserId(ctx.userId);
      return readLibraryGroups({
        userId,
        ...(input.workspaceId || input.projectId ? { lens: input } : {}),
      });
    }),

  /** One group and the first page of its items. */
  group: podProcedure
    .input(
      z.object({
        groupId: uuid,
        limit: z.number().int().min(1).max(LIBRARY_LIMITS.pageMax).optional(),
      })
    )
    .query(async ({ ctx, input }): Promise<LibraryGroupResult> => {
      const userId = requireUserId(ctx.userId);
      await adoptImportGroups({ userId });
      const row = await loadLibraryGroup({ userId, groupId: input.groupId });
      const { views } = await groupViews({ userId, rows: [row] });
      const page = await listLibraryItems({
        userId,
        input: {
          groupId: row.id,
          ...(input.limit ? { limit: input.limit } : {}),
        },
      });
      return { group: views[0]!, ...page };
    }),

  /** The person's edits, atomically. A bad op is BAD_REQUEST and writes nothing. */
  curate: personProcedure
    .input(
      z.object({
        ops: z
          .array(LibraryCurateOpSchema)
          .min(1)
          .max(LIBRARY_LIMITS.curateOpsMax),
      })
    )
    .mutation(async ({ ctx, input }): Promise<LibraryCurateResult> => {
      const userId = requireUserId(ctx.userId);
      await adoptImportGroups({ userId });
      return curateLibrary({ userId, ops: input.ops });
    }),

  /** ONE search over captures and the Library. */
  search: podProcedure
    .input(LibrarySearchInputSchema)
    .query(async ({ ctx, input }): Promise<LibrarySearchResult> => {
      const userId = requireUserId(ctx.userId);
      return searchLibrary({ userId, q: input.q, limit: input.limit });
    }),

  /** One item, structured now and filed alone (governed). */
  readNow: personProcedure
    .use(aiRateLimitMiddleware)
    .input(z.object({ itemId: uuid }))
    .mutation(async ({ ctx, input }): Promise<ImportBuildResult> => {
      const userId = requireUserId(ctx.userId);
      return readNowDoor(ctx, userId, input.itemId);
    }),

  /** Run one suggested chip as ONE governed proposal. */
  runAction: personProcedure
    .input(z.object({ itemId: uuid, actionId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }): Promise<LibraryRunActionResult> => {
      const userId = requireUserId(ctx.userId);
      return runLibraryActionDoor({
        userId,
        itemId: input.itemId,
        actionId: input.actionId,
      });
    }),

  /** A group → one governed bundle (first build, or a rebuild over what is new). */
  build: personProcedure
    .use(aiRateLimitMiddleware)
    .input(z.object({ groupId: uuid }))
    .mutation(async ({ ctx, input }): Promise<ImportBuildResult> => {
      const userId = requireUserId(ctx.userId);
      const result = await buildLibraryGroup({
        userId,
        groupId: input.groupId,
        depsFor: depsFor(ctx, userId),
      });
      if (
        result.status === "refused" &&
        result.reason === "previous_build_pending"
      ) {
        // A rebuild now would twin what the waiting bundle makes.
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This group's last build is still waiting for your review. Approve or reject it, then build again.",
          cause: {
            reasonCode: "PREVIOUS_BUILD_PENDING",
            ...(result.proposalId
              ? { pendingProposalId: result.proposalId }
              : {}),
          },
        });
      }
      return result;
    }),

  /** Unread / groups waiting / oldest wait. */
  health: podProcedure.query(async ({ ctx }): Promise<LibraryHealth> => {
    const userId = requireUserId(ctx.userId);
    return libraryHealth({ userId });
  }),
});
