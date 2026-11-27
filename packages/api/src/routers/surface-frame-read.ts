/**
 * `surfaces.frameRead` — THE frame read door, tRPC twin of Hub
 * `POST /frame/read` (`services/surfaces/frame-read.ts`). Merged into the
 * `surfaces` router (`root.ts`), kept in its own file so the Surfaces doors
 * grow apart.
 *
 * A host forwards each `window.synap.query(op, params)` of a frame here with
 * the surface the frame draws (`{kind:"cell", typeKey}`,
 * `{kind:"document", id}`, or `{kind:"draft", draftId}` for the caller's own
 * unsaved draft) and its lens (`workspaceId`, used for a cell or a draft; a
 * page reads in its own space). The pod refuses a read the surface does not
 * declare (FORBIDDEN, `cause.reasonCode: "FRAME_READ_UNDECLARED"`), runs the
 * rest as the viewer, and logs every call. A query: it changes no pod data
 * (the log line is the door's own record).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { router, protectedProcedure } from "../trpc.js";
import { frameRead, FrameReadError } from "../services/surfaces/frame-read.js";

export const frameReadInput = z.object({
  surface: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cell"), typeKey: z.string().min(1).max(200) }),
    z.object({ kind: z.literal("document"), id: z.string().uuid() }),
    // A person's own unsaved draft (a preview): reads with their access.
    z.object({ kind: z.literal("draft"), draftId: z.string().uuid() }),
  ]),
  op: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
  /** The host's lens: the space the frame draws in (a cell's read runs there). */
  workspaceId: z.string().uuid().nullable().optional(),
});

const TRPC_CODE = {
  400: "BAD_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  429: "TOO_MANY_REQUESTS",
} as const;

export const surfaceFrameReadRouter = router({
  frameRead: protectedProcedure
    .input(frameReadInput)
    .query(async ({ ctx, input }) => {
      try {
        return await frameRead(ctx, input);
      } catch (err) {
        if (err instanceof FrameReadError) {
          throw new TRPCError({
            code: TRPC_CODE[err.status],
            message: err.message,
            cause: { reasonCode: err.code },
          });
        }
        throw err;
      }
    }),
});
