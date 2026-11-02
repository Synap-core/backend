/**
 * THE lens page read's input: `signals.list({ lens: "page" })` at a scope,
 * with the caps every lens host asks for (`LENS_PAGE_READ_CAPS`).
 *
 * One builder for every door that reads a lens page WHOLE on a caller's
 * behalf: the Hub REST `GET /attention/lens-page` (the browser host bridge's
 * `lens.page` op, a space package's frame) and the `lens.page` builtin verb (a
 * document refresher grounding its words). The widgets and the refresher read
 * the same rows because they ask through the same input, never two spellings
 * of it.
 */
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";

/** A lens page's scope: the narrowing axes `signals.list` composes (each ANDs). */
export interface LensPageAxes {
  workspaceId?: string;
  projectId?: string;
  trackId?: string;
  sessionId?: string;
  /** Happened from this instant; absent = the whole history. */
  since?: string;
}

export function lensPageListInput(q: LensPageAxes) {
  return {
    lens: "page" as const,
    ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
    ...(q.projectId ? { projectId: q.projectId } : {}),
    ...(q.trackId ? { trackId: q.trackId } : {}),
    ...(q.sessionId ? { sessionId: q.sessionId } : {}),
    caps: { ...LENS_PAGE_READ_CAPS },
    ...(q.since ? { since: q.since } : {}),
  };
}
