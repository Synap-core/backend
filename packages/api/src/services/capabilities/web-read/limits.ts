/**
 * Limits of the built-in reader. `BUILTIN_READ_TEXT_MAX` is the most text one
 * read keeps — the Library light read's own cap must not exceed it.
 */
export const BUILTIN_READ_TEXT_MAX = 50_000;

/** Below this many characters of body text a page is not adequately read. */
export const ADEQUATE_BODY_CHARS = 400;

/** Top-level comments a discussion adapter (HN, Reddit) keeps. */
export const DISCUSSION_COMMENTS_MAX = 10;

/**
 * Bytes of a page's HTML read at most (an article fits; a JS bundle need not).
 * Also the most HTML extraction ever parses — the page the person's browser
 * sent is cut to it too.
 */
export const WEB_READ_PAGE_BYTES_MAX = 1_500_000;

/**
 * Above either of these the page is not handed to the DOM extractor
 * (defuddle on linkedom), whose passes are super-linear in nesting depth and
 * element count (measured: 2 000 nested `<div>` ≈ 26 s, 512 ≈ 1.6 s,
 * 256 ≈ 0.4 s); the linear readable-text pass reads it instead. Real
 * articles nest < 60 deep and hold a few thousand elements.
 */
export const EXTRACT_DOM_DEPTH_MAX = 256;
export const EXTRACT_DOM_ELEMENTS_MAX = 12_000;

/**
 * Wall-clock budget of one extraction, run in a worker thread. Past it the
 * worker is terminated and the read is `failed: extract_timeout` (retryable)
 * — a page can never hold the pod's event loop. A 3 000-element article
 * extracts in ≈ 1 s.
 */
export const EXTRACT_DEADLINE_MS = 8_000;
