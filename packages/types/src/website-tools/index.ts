/**
 * WEBSITES AS TOOLS: the ONE rule for "this saved link is one of the person's
 * tools" (plan c727854c W5, review a661b1a3). The pod's "your apps" read
 * (`preferences.yourApps`) and the desktop's Tools grid both read it, so a
 * site is a tool in both or in neither.
 *
 * A saved link (a `website` / `bookmark` entity) is a tool when its `tags`
 * carry {@link WEBSITE_TOOL_TAG} AND its `url` is an http(s) address
 * (`isHttpUrl`, the one link rule): a tool opens in one click, so a
 * `javascript:`, `data:` or `file:` link an agent tagged is never one.
 *
 * Pure and dependency-free (it imports only the link rule).
 */

import { isHttpUrl } from "../navigation/index.js";

/** The tag that makes a saved link one of the person's tools. */
export const WEBSITE_TOOL_TAG = "tool";

/** Does this entity's `tags` property carry the tool tag? Tags arrive as an array or a comma string. */
export function hasToolTag(tags: unknown): boolean {
  const list = Array.isArray(tags)
    ? tags
    : typeof tags === "string"
      ? tags.split(",")
      : [];
  return list.some(
    (tag) =>
      typeof tag === "string" && tag.trim().toLowerCase() === WEBSITE_TOOL_TAG
  );
}

/** The address's host, without `www.` ("figma.com"); the input itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A saved link as an entity read returns it (only the fields read here). */
export interface SavedLinkRow {
  id: string;
  title?: string | null;
  properties?: unknown;
}

/** A saved link's http(s) address, or null (none, blank, or another scheme). */
export function savedLinkUrl(row: SavedLinkRow): string | null {
  const props =
    row.properties && typeof row.properties === "object"
      ? (row.properties as Record<string, unknown>)
      : {};
  const url = typeof props.url === "string" ? props.url.trim() : "";
  return isHttpUrl(url) ? url : null;
}

/** Whether the row's tags carry the tool tag (whatever its address). */
export function isTaggedTool(row: SavedLinkRow): boolean {
  const props =
    row.properties && typeof row.properties === "object"
      ? (row.properties as Record<string, unknown>)
      : {};
  return hasToolTag(props.tags);
}

export interface WebsiteTool {
  id: string;
  /** Its title, else its host. */
  name: string;
  url: string;
}

/** The row as a tool, or null when it is not one (no tool tag, or no http(s) address). */
export function websiteToolOf(row: SavedLinkRow): WebsiteTool | null {
  if (!isTaggedTool(row)) return null;
  const url = savedLinkUrl(row);
  if (!url) return null;
  return { id: row.id, name: row.title?.trim() || hostOf(url), url };
}
