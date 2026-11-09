/**
 * How the intent registry is ranked against a person's words — ONE function,
 * so `findByIntent`'s intents arm and the tests that measure it rank the same
 * way. Pure: the rows come from `listIntentRows` (seed ∪ `capability_intents`).
 *
 * A row is ranked on its slug AND its own words: "remove my background" is
 * `edit_video` only through its synonym "remove background", and "transcribe
 * this video" reaches `transcribe_media` through its slug. Before, only the
 * slug ranked, so a synonym stored on a row was never read (audit 732371eb
 * §4, finding 9463e6b3).
 */
import { rankByTerms } from "../../utils/term-match.js";
import type { IntentRow } from "./intent-registry.js";

/** Words for an intent slug, so "send a message" reaches `send_message`. */
export function intentText(slug: string): string {
  return slug.replace(/_/g, " ");
}

/** The registry ranked against `query`, best first; zero-score rows dropped. */
export function rankIntentRows(query: string, rows: readonly IntentRow[]) {
  return rankByTerms(
    query,
    rows,
    (v) => ({
      primary: [v.slug, intentText(v.slug)],
      secondary: v.synonyms,
      tertiary: v.statement || null,
    }),
    { primary: "intent", secondary: "synonyms", tertiary: "statement" }
  );
}
