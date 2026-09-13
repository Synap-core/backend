/**
 * Tool identity — the ONE normalization of a tool name, shared by the pod
 * (`recordToolDemand`), the clients (onboarding tools list) and the Control
 * Plane contract (`POST /api/demand/tools` accepts exactly `TOOL_KEY_PATTERN`).
 *
 * Pure and dependency-free. A second normalizer anywhere is a fork: two
 * spellings of one tool would count as two demands.
 */

/** The key shape every door accepts. */
export const TOOL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * The pg-boss queue that forwards demand to the Control Plane — enqueued by the
 * api's `recordToolDemand`, worked by the jobs worker. One name, one place.
 */
export const TOOL_DEMAND_FORWARD_QUEUE = "tool-demand-forward";

/**
 * "Google Calendar" → "google-calendar", "Notion.so" → "notion-so",
 * "Évernote" → "evernote". Returns null when nothing usable remains.
 */
export function normalizeToolName(name: string): string | null {
  const key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return TOOL_KEY_PATTERN.test(key) ? key : null;
}
