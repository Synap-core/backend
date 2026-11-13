/**
 * Place a multi-slide artboard deck (carousel/deck) on a whiteboard: the
 * builtin `output.generate` verb's write, through THE place door
 * (`placeOnBoard`, services/whiteboards/place-on-board.ts) like every other
 * placement. One artboard per slide, each holding its slide's html-embed cell;
 * written into the open board or its saved file; governed as `whiteboard/place`.
 *
 * (It used to emit a socket event that every open browser applied on its own:
 * duplicated shapes with several viewers, nothing at all with none. That event
 * is retired.)
 *
 * The deck shape is the `artboard-deck` resource of `BoardResourceRef`
 * (`@synap-core/types/whiteboard`): `{ preset, title?, slides:[{ html, title? }] }`.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { BoardPlacePartResult } from "@synap-core/types/whiteboard";
import {
  BoardPlaceError,
  placeOnBoard,
} from "../whiteboards/place-on-board.js";

/** One slide of an artboard deck — HTML content with an optional title. */
export const ArtboardDeckSlideSchema = z.object({
  html: z.string(),
  title: z.string().optional(),
});

/** The artboard-deck resource (the `artboard-deck` kind of BoardResourceRef). */
export const ArtboardDeckSchema = z.object({
  preset: z.string(),
  title: z.string().optional(),
  slides: z.array(ArtboardDeckSlideSchema).min(1),
});

export type ArtboardDeck = z.infer<typeof ArtboardDeckSchema>;

/** Where to put it (the place door's `options`). */
export const BoardPlacementOptionsSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  frameId: z.string().optional(),
  layout: z.enum(["stack", "grid", "flow", "freeform"]).optional(),
});

export type BoardPlacementOptions = z.infer<typeof BoardPlacementOptionsSchema>;

/** Place one `artboard-deck` resource through the place door. */
export async function placeArtboardDeck(input: {
  /** The whiteboard view id (board) to place onto. */
  viewId: string;
  deck: ArtboardDeck;
  options?: BoardPlacementOptions;
  /** The person, the agent, and the space the run acts in (the door's fence). */
  userId: string;
  agentUserId?: string | null;
  workspaceId: string;
}): Promise<{
  viewId: string;
  slideCount: number;
  placement: BoardPlacePartResult | undefined;
}> {
  const { viewId, deck, options } = input;
  try {
    const result = await placeOnBoard({
      viewId,
      userId: input.userId,
      agentUserId: input.agentUserId ?? null,
      request: {
        resources: [
          {
            kind: "artboard-deck",
            preset: deck.preset,
            ...(deck.title !== undefined ? { title: deck.title } : {}),
            slides: deck.slides,
          },
        ],
        ...(options ? { options } : {}),
        workspaceId: input.workspaceId,
      },
    });
    return {
      viewId,
      slideCount: deck.slides.length,
      placement: result.created,
    };
  } catch (err) {
    if (err instanceof BoardPlaceError) {
      throw new TRPCError({
        code:
          err.status === 404
            ? "NOT_FOUND"
            : err.status === 403
              ? "FORBIDDEN"
              : err.status === 400
                ? "BAD_REQUEST"
                : err.status === 409
                  ? "CONFLICT"
                  : "INTERNAL_SERVER_ERROR",
        message: `${err.message} (reason: ${err.reason})`,
      });
    }
    throw err;
  }
}
