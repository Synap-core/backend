/**
 * What the Library doors and the import doors share (`library.*`,
 * `import.*`, Hub `/library/*`): the person-only procedure and the staged-item
 * schema. One copy, so the doors cannot drift.
 */

import { z } from "zod";
import {
  IMPORT_LIMITS,
  type ImportStageItemInput,
} from "@synap-core/types/imports";
import { podProcedure } from "../trpc.js";
import { refuseAgent } from "../services/library/agent-door.js";

/**
 * A WRITE that only a person may make: an agent key or the IS internal key is
 * FORBIDDEN (`AGENT_USE_CAPTURE`). Nothing an agent sends lands in the Library
 * — and an import run IS a Library run, so the import doors refuse it too.
 */
export const personProcedure = podProcedure.use(async ({ ctx, next }) => {
  refuseAgent(ctx);
  return next();
});

const L = IMPORT_LIMITS;
/** Base64 grows bytes by 4/3; a little slack for padding. */
export const INLINE_BASE64_MAX = Math.ceil((L.inlineFileBytesMax * 4) / 3) + 8;

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
