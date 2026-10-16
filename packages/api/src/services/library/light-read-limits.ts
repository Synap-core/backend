/**
 * The light read's bounds — one place, shared by its modules
 * (`light-read.ts`, `light-read-content.ts`, `light-read-store.ts`,
 * `light-read-deps.ts`).
 */

import { BUILTIN_READ_TEXT_MAX } from "../capabilities/web-read/limits.js";
import { TRANSCRIBE_STORED_MEDIA_MAX_BYTES } from "../media-copy/transcribe-stored-media.js";
import { LIBRARY_READ_WINDOW_MS } from "./read-budget.js";

/** Characters of text kept (stored, summarised, searched) — the built-in reader's own cap. */
export const LIGHT_READ_TEXT_MAX = BUILTIN_READ_TEXT_MAX;
/** Characters of text the AI summary sees. */
export const LIGHT_READ_SUMMARY_INPUT_MAX = 6_000;
/** A summary is a few sentences. */
export const LIGHT_READ_SUMMARY_MAX = 400;
/** Text this short IS its own summary (no AI). */
export const LIGHT_READ_SHORT_TEXT = 280;
/** Bytes the pod sends the IS for one file. */
export const LIGHT_READ_FILE_BYTES_MAX = 20 * 1024 * 1024;
/** Group names offered to the summary call to pick from. */
export const LIGHT_READ_GROUPS_OFFERED = 20;
/** Groups the summary call may pick for one item. */
export const LIGHT_READ_GROUPS_PICKED = 2;
/** Characters of read text the lexical group match sees. */
export const LIGHT_READ_SUGGEST_TEXT_MAX = 2000;
/** The file extraction's own timeout (a bulk-lane read is never urgent). */
export const LIGHT_READ_EXTRACT_TIMEOUT_MS = 60_000;
/** Output budget of the summary call. */
export const LIGHT_READ_SUMMARY_MAX_TOKENS = 600;
/** Bytes of a text-like file (txt, csv, json, md…) a light read buffers at most. */
export const LIGHT_READ_TEXT_FILE_BYTES_MAX = 4 * 1024 * 1024;
/**
 * Failed reads that count toward giving up on an item (`unreadable`): a
 * PERMANENT failure class, or any failure of a reader billed on the person's
 * account (every try may cost). A transient failure of a free reader (the
 * site, the vendor or the IS down, the extractor busy) never counts: it waits
 * {@link lightReadRetryDelayMs} and is tried again.
 */
export const LIGHT_READ_MAX_ATTEMPTS = 3;
/** First wait after a transient failure; doubles per consecutive failure. */
export const LIGHT_READ_RETRY_BASE_MS = 15 * 60 * 1000;
/** Longest wait between two tries of a transient failure. */
export const LIGHT_READ_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait before trying again after the `n`-th consecutive transient
 * failure (n ≥ 1): exponential from {@link LIGHT_READ_RETRY_BASE_MS}, capped
 * at {@link LIGHT_READ_RETRY_MAX_MS}, never shorter than what the site or
 * vendor asked (`retryAfterSec`).
 */
export function lightReadRetryDelayMs(
  n: number,
  retryAfterSec?: number
): number {
  const exp = Math.min(
    LIGHT_READ_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(n, 20) - 1),
    LIGHT_READ_RETRY_MAX_MS
  );
  return Math.max(exp, (retryAfterSec ?? 0) * 1000);
}
/** Bytes of a copied video the STT step sends (the transcriber's own ceiling). */
export const LIGHT_READ_TRANSCRIBE_BYTES_MAX =
  TRANSCRIBE_STORED_MEDIA_MAX_BYTES;
/** How long a checkpointed billed read may be resumed (the budget unit's window). */
export const READ_CHECKPOINT_TTL_MS = LIBRARY_READ_WINDOW_MS;
