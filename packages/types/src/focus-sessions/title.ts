/**
 * A focus session's DISPLAY NAME — ONE resolver, platform-wide.
 *
 * A session carries two texts that answer different questions:
 *   - `title` — the short, optional one-line NAME ("Billing launch").
 *   - `goal`  — the OUTCOME, which may be a paragraph.
 *
 * Every list, card, tab and breadcrumb shows the title when there is one and
 * otherwise the goal's first line, clipped. Relay and the browser both render
 * sessions, so a per-surface copy of this rule is a fork the moment it exists —
 * the same reason `statuses.ts` lives here. Pure; its only import is the
 * package's own entity decoder.
 */

import { decodeHtmlEntities } from "../text/html-entities.js";

/** Stored bound of `focus_sessions.title` (varchar). Doors refuse longer. */
export const SESSION_TITLE_MAX = 200;

/** Default clip for the goal fallback — a list row, not a paragraph. */
export const SESSION_TITLE_FALLBACK_MAX = 80;

/** Collapse every whitespace run (newlines included) to one space, trimmed. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Canonical form of a caller-supplied title: HTML entities decoded (agents
 * sometimes XML-escape tool arguments, so `A &amp; B` must store as `A & B`),
 * one line, trimmed, and `null` when nothing is left. Every door that writes a
 * session title calls this, so the decode happens once. Does NOT clip — a title
 * over {@link SESSION_TITLE_MAX} is the door's to refuse, never silently
 * shortened. `goal` is NOT decoded here: it is the outcome text, not the name.
 */
export function normalizeSessionTitle(
  title: string | null | undefined
): string | null {
  if (typeof title !== "string") return null;
  const line = oneLine(decodeHtmlEntities(title));
  return line.length > 0 ? line : null;
}

/** Clip at a word boundary, ending in an ellipsis. */
function clip(line: string, max: number): string {
  if (line.length <= max) return line;
  let cut = line.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to a word boundary when it keeps most of the budget; a single
  // very long first word is cut mid-word rather than reduced to nothing.
  if (lastSpace >= Math.floor(max / 2)) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * The name to show for a session: the trimmed `title` when non-empty, else the
 * goal's first non-empty line clipped to `maxLength` at a word boundary.
 * Returns `""` only when both are empty — the surface owns its empty copy.
 */
export function resolveSessionTitle(
  session: { title?: string | null; goal?: string | null },
  opts: { maxLength?: number } = {}
): string {
  const title = normalizeSessionTitle(session.title);
  if (title) return title;
  const max = opts.maxLength ?? SESSION_TITLE_FALLBACK_MAX;
  const firstLine =
    (session.goal ?? "")
      .split(/\r?\n/)
      .map(oneLine)
      .find((l) => l.length > 0) ?? "";
  return clip(firstLine, max);
}
