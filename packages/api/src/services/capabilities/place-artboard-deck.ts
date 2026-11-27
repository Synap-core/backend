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

import {
  ArtboardDeckSchema,
  BoardPlacementOptionsSchema,
  type ArtboardDeck,
  type BoardPlacePartResult,
  type BoardPlacementOptions,
} from "@synap-core/types/whiteboard";
import {
  BoardPlaceError,
  boardPlaceErrorToTrpc,
  placeOnBoard,
} from "../whiteboards/place-on-board.js";

// The deck and the options are the place door's own schemas: one contract.
export { ArtboardDeckSchema, BoardPlacementOptionsSchema };
export type { ArtboardDeck, BoardPlacementOptions };

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
    if (err instanceof BoardPlaceError) throw boardPlaceErrorToTrpc(err);
    throw err;
  }
}
