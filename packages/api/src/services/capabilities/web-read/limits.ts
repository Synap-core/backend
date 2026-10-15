/**
 * Limits of the built-in reader. `BUILTIN_READ_TEXT_MAX` equals the Library
 * light read's `LIGHT_READ_TEXT_MAX` (services/library/light-read.ts) — the
 * text the pod keeps, summarises and searches for one item. A parity test
 * pins the two; when the light read is rerouted through the one door, it
 * should import this instead of declaring its own.
 */
export const BUILTIN_READ_TEXT_MAX = 50_000;

/** Below this many characters of body text a page is not adequately read. */
export const ADEQUATE_BODY_CHARS = 400;

/** Top-level comments a discussion adapter (HN, Reddit) keeps. */
export const DISCUSSION_COMMENTS_MAX = 10;
