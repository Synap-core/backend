/**
 * THE ONE PLACEHOLDER of a block a client cannot draw (plan 9ad4b2fc §1, lane
 * 18 words). A client that cannot draw something SAYS so, in one of three
 * states, and never leaves an empty block (prior art: Adaptive Cards in Teams
 * dropped unsupported elements silently):
 *
 *   unsupported  this client cannot draw this kind of block (a frame the
 *                phone does not run yet, a widget it has no twin for): the
 *                block's snapshot or fallback sentence, and "Open in app";
 *   no-access    the reader may not read what the block shows: no retry,
 *                trying again changes nothing;
 *   failed       the block's read failed: retryable, never "nothing here".
 *
 * An AUTHORING problem (the block's settings name nothing it can draw) is not
 * one of these: its reader gets "Couldn’t draw this block" and its author the
 * diagnosis (`readLensSectionBlock`, mode `author`).
 *
 * The words are `./block-copy` (en + fr); WHERE the fallback sentence comes
 * from (the snapshot, the catalog's `fallback`) and how "Open in app" opens
 * are each client's. Pure.
 */
import type { Locale } from "../i18n/index.js";
import { lensBlockT } from "./block-copy.js";

export const BLOCK_PLACEHOLDER_STATES = [
  "unsupported",
  "no-access",
  "failed",
] as const;
export type BlockPlaceholderState = (typeof BLOCK_PLACEHOLDER_STATES)[number];

/** The one act each state offers: open it where it can be drawn, try again, or none. */
export const BLOCK_PLACEHOLDER_ACT = {
  unsupported: "open",
  "no-access": null,
  failed: "retry",
} as const satisfies Record<BlockPlaceholderState, "open" | "retry" | null>;
export type BlockPlaceholderAct = NonNullable<
  (typeof BLOCK_PLACEHOLDER_ACT)[BlockPlaceholderState]
>;

const TITLE_KEY = {
  unsupported: "block.placeholder.unsupported.title",
  "no-access": "block.placeholder.noAccess.title",
  failed: "block.placeholder.failed.title",
} as const satisfies Record<BlockPlaceholderState, string>;

const ACT_KEY = {
  open: "block.placeholder.open",
  retry: "block.placeholder.retry",
} as const satisfies Record<BlockPlaceholderAct, string>;

/** What the placeholder says in `state`: its title, and its one act with that act's label. */
export interface BlockPlaceholderWords {
  state: BlockPlaceholderState;
  title: string;
  act: { kind: BlockPlaceholderAct; label: string } | null;
}

/** The placeholder's words in `state`, in `locale` (else the ambient catalog locale). */
export function blockPlaceholder(
  state: BlockPlaceholderState,
  locale?: Locale
): BlockPlaceholderWords {
  const t = lensBlockT(locale);
  const act = BLOCK_PLACEHOLDER_ACT[state];
  return {
    state,
    title: t(TITLE_KEY[state]),
    act: act ? { kind: act, label: t(ACT_KEY[act]) } : null,
  };
}
