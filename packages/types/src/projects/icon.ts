/**
 * A PROJECT'S ICON — one string, two shapes, one parser for every surface.
 *
 * `projects.icon` (migration 0328) stores either
 *   - ONE emoji (a single grapheme: a ZWJ family, a flag, a skin tone and a
 *     keycap each count as one), or
 *   - `glyph:<name>` — a lucide icon name in kebab case (`glyph:rocket`).
 * NULL means none was chosen; surfaces then draw the initials on the colour
 * plate (`resolveProjectColorSlot`).
 *
 * The backend refuses anything else on write (`isProjectIcon`), so a reader
 * never meets a third shape. A glyph name is checked for SHAPE only: the
 * backend ships no icon set, so a well-formed name the client's icon set does
 * not know is drawn as the initials fallback, never as an error.
 *
 * Pure and dependency-free: the browser, relay and the CLI read the same rule.
 */

export const PROJECT_ICON_GLYPH_PREFIX = "glyph:";

/** Longest stored value — a long ZWJ emoji or a long lucide name fits. */
export const PROJECT_ICON_MAX_LENGTH = 64;

export type ProjectIcon =
  { kind: "emoji"; emoji: string } | { kind: "glyph"; name: string };

const GLYPH_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// One emoji element: a flag (two regional indicators), a keycap, or a
// pictograph with optional presentation selector, skin tone and tag sequence
// (subdivision flags). Elements chain with ZWJ into ONE grapheme.
const ELEMENT =
  "(?:\\p{Regional_Indicator}{2}" +
  "|[#*0-9]\\uFE0F?\\u20E3" +
  "|\\p{Extended_Pictographic}[\\uFE0E\\uFE0F]?\\p{Emoji_Modifier}?" +
  "[\\u{E0020}-\\u{E007E}]*\\u{E007F}?)";
const SINGLE_EMOJI = new RegExp(`^${ELEMENT}(?:\\u200D${ELEMENT})*$`, "u");

/** The stored value, read; `null` for none or for a malformed value. */
export function parseProjectIcon(value: unknown): ProjectIcon | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > PROJECT_ICON_MAX_LENGTH) {
    return null;
  }
  if (value.startsWith(PROJECT_ICON_GLYPH_PREFIX)) {
    const name = value.slice(PROJECT_ICON_GLYPH_PREFIX.length);
    return GLYPH_NAME.test(name) ? { kind: "glyph", name } : null;
  }
  return SINGLE_EMOJI.test(value) ? { kind: "emoji", emoji: value } : null;
}

/** A value the backend will store: one emoji or `glyph:<kebab-name>`. */
export function isProjectIcon(value: unknown): value is string {
  return parseProjectIcon(value) !== null;
}

/** The stored string for a glyph name (`rocket` → `glyph:rocket`). */
export function projectGlyphIcon(name: string): string {
  return `${PROJECT_ICON_GLYPH_PREFIX}${name}`;
}
