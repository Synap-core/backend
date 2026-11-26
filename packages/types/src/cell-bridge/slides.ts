/**
 * The slide door: how a host presents a stored HTML page as a deck.
 *
 * A page marks its slides with `data-slide` (the addressable-block
 * convention of backend `services/document-patch/html-blocks.ts`): a slide's
 * id is its `data-block-id`, else its `data-slide` value, else `slide-<n>`
 * counting slides from 1 in document order. The host reads the deck from the
 * page's block manifest (`documents.metadata.blocks`, kind `slide`) and drives
 * the frame; the in-frame SDK (`sdk.ts`) shows one slide at a time.
 *
 *   host → frame   `synap:slide:goto`     { slideId, index }
 *   frame → host   `synap:slide:changed`  { slideId, index, total }
 *
 * `goto` names the slide by id; `index` (0-based) is the fallback when no
 * slide carries that id (a manifest a save behind the page). The frame
 * answers every `goto` it could follow with `changed`, and sends `changed` on
 * its own when the reader moves with the keyboard inside the frame (focus in
 * a frame keeps its keys from the host). A page with no slide answers
 * nothing.
 *
 * While presenting, every other `data-slide` element is hidden on screen
 * (`html[data-synap-presenting]`); printing shows every slide, one per page.
 *
 * Not part of the bundle contract (`CELL_BRIDGE_CONTRACT_VERSION`): the host
 * injects the SDK that answers these messages with the page itself, so no
 * renderer bundle can depend on them.
 */

export const FRAME_SLIDE_GOTO_TYPE = "synap:slide:goto" as const;
export const FRAME_SLIDE_CHANGED_TYPE = "synap:slide:changed" as const;

/** The attribute that makes an element a slide. */
export const FRAME_SLIDE_ATTRIBUTE = "data-slide" as const;

/** Host → frame: show this slide. */
export interface FrameSlideGotoMessage {
  type: typeof FRAME_SLIDE_GOTO_TYPE;
  slideId: string;
  /** 0-based position, used when no slide carries `slideId`. */
  index: number;
}

/** Frame → host: this slide is showing. */
export interface FrameSlideChangedMessage {
  type: typeof FRAME_SLIDE_CHANGED_TYPE;
  slideId: string;
  /** 0-based, in document order. */
  index: number;
  /** How many slides the page has. */
  total: number;
}

const MAX_SLIDE_ID_LENGTH = 200;
const MAX_SLIDES = 10_000;

/** The message a host posts to show one slide. */
export function frameSlideGoto(
  slideId: string,
  index: number
): FrameSlideGotoMessage {
  return { type: FRAME_SLIDE_GOTO_TYPE, slideId, index };
}

const isCount = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * A slide report from a frame, validated, or null. The frame is stored code
 * the host does not trust: an id that is not a short string, or a position
 * outside the deck it claims, is dropped.
 */
export function parseFrameSlideChanged(
  data: unknown
): FrameSlideChangedMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type !== FRAME_SLIDE_CHANGED_TYPE) return null;
  const { slideId, index, total } = msg;
  if (
    typeof slideId !== "string" ||
    slideId.length === 0 ||
    slideId.length > MAX_SLIDE_ID_LENGTH
  ) {
    return null;
  }
  if (!isCount(total, MAX_SLIDES) || total === 0) return null;
  if (!isCount(index, total - 1)) return null;
  return { type: FRAME_SLIDE_CHANGED_TYPE, slideId, index, total };
}
