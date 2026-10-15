/**
 * The light read's bounds — one place, shared by its modules
 * (`light-read.ts`, `light-read-content.ts`, `light-read-store.ts`,
 * `light-read-deps.ts`).
 */

import { BUILTIN_READ_TEXT_MAX } from "../capabilities/web-read/limits.js";
import { TRANSCRIBE_STORED_MEDIA_MAX_BYTES } from "../media-copy/transcribe-stored-media.js";

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
/** IS failures before an item is marked `unreadable`. */
export const LIGHT_READ_MAX_ATTEMPTS = 3;
/** Bytes of a copied video the STT step sends (the transcriber's own ceiling). */
export const LIGHT_READ_TRANSCRIBE_BYTES_MAX =
  TRANSCRIBE_STORED_MEDIA_MAX_BYTES;
/** How long a checkpointed billed read may be resumed (the budget unit's window). */
export const READ_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
