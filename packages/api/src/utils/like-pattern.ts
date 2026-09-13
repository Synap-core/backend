/**
 * Escape the LIKE / ILIKE wildcards in user-typed text, so a search for
 * "50%" or "a_b" matches those characters instead of treating them as `%`
 * (any run) and `_` (any one character).
 *
 * Uses the default LIKE escape character (backslash), which Postgres applies
 * when no ESCAPE clause is given. The same one-line idiom already sits inline
 * at `services/team-roster-context.ts` and in `identity-resolution-service.ts`;
 * this is the shared spelling for new search doors, so a third inline copy
 * does not become the one that forgets the backslash itself.
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/([%_\\])/g, "\\$1");
}
