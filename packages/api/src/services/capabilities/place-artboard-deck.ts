/**
 * Shared artboard-deck placement — the ONE function that materializes a
 * multi-slide deck/carousel onto a whiteboard by emitting the `board:place`
 * socket event.
 *
 * BOTH callers use this single function so the emit logic lives in exactly one
 * place (no duplicated event shape):
 *   - Hub REST `POST /whiteboards/:viewId/place` (the existing IS-tool path;
 *     `generate_carousel` / `generate_deck` → hub.placeOnWhiteboard → this route)
 *   - The Tier-0 builtin capability verb `output.generate` (BUILTIN_VERBS) — the
 *     governed, discoverable capability surface any client can run via
 *     run_capability.
 *
 * The deck resource shape is kept in sync with the `artboard-deck` branch of the
 * whiteboards route's `BoardResourceRefSchema` and the IS place-on-whiteboard
 * union: `{ kind:"artboard-deck", preset, title?, slides:[{ html, title? }] }`.
 * The board client materializes one artboard per slide.
 */

import { z } from "zod";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";

/** One slide of an artboard deck — HTML content with an optional title. */
export const ArtboardDeckSlideSchema = z.object({
  html: z.string(),
  title: z.string().optional(),
});

/** The artboard-deck resource — mirrors the whiteboards route + IS union. */
export const ArtboardDeckSchema = z.object({
  preset: z.string(),
  title: z.string().optional(),
  slides: z.array(ArtboardDeckSlideSchema).min(1),
});

export type ArtboardDeck = z.infer<typeof ArtboardDeckSchema>;

/** Optional layout options passed through to the board client verbatim. */
export const BoardPlacementOptionsSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  frameId: z.string().optional(),
  layout: z.enum(["stack", "grid", "flow", "freeform"]).optional(),
});

export type BoardPlacementOptions = z.infer<typeof BoardPlacementOptionsSchema>;

/**
 * Emit the `board:place` socket event to a whiteboard's room so connected clients
 * materialize the given resources immediately. Fire-and-forget (emitChatEvent
 * never blocks / never throws).
 *
 * This is the SOLE `board:place` emit site — BOTH the Hub REST
 * `POST /whiteboards/:viewId/place` route (any resource kinds) AND the builtin
 * `output.generate` verb (artboard-deck) call it, so the event shape can never
 * diverge between the two placement paths.
 */
export function emitBoardPlace(input: {
  /** The whiteboard view id (board) to place onto. */
  viewId: string;
  /** The resources to place — passed to the board client verbatim. */
  resources: unknown[];
  /** Optional layout hints forwarded to the board client. */
  options?: BoardPlacementOptions;
}): void {
  emitChatEvent({
    event: "board:place",
    data: {
      viewId: input.viewId,
      resources: input.resources,
      options: input.options,
    },
    viewId: input.viewId,
  });
}

/**
 * Place a single `artboard-deck` resource onto a whiteboard via {@link emitBoardPlace}.
 * The convenience wrapper used by the builtin `output.generate` verb: it builds the
 * one locked `artboard-deck` resource and returns the placed slide count.
 */
export function placeArtboardDeck(input: {
  /** The whiteboard view id (board) to place onto. */
  viewId: string;
  /** The deck resource — preset + slides. */
  deck: ArtboardDeck;
  /** Optional layout hints forwarded to the board client. */
  options?: BoardPlacementOptions;
}): { viewId: string; slideCount: number } {
  const { viewId, deck, options } = input;

  emitBoardPlace({
    viewId,
    resources: [
      {
        kind: "artboard-deck",
        preset: deck.preset,
        ...(deck.title !== undefined ? { title: deck.title } : {}),
        slides: deck.slides,
      },
    ],
    options,
  });

  return { viewId, slideCount: deck.slides.length };
}
