/**
 * WORK GRAPH EDGE KINDS — the kinds of edge the pod's work graph read
 * (`focusSessions.graph`, Hub `GET /focus-sessions/graph`) returns, declared
 * ONCE for every surface.
 *
 * The graph is built in the backend (`packages/api/src/services/
 * focus-sessions/work-graph.ts`), which re-exports this list, so the read and
 * its readers can never name different kinds. It lives here because the apps
 * kept a hand copy of the union that had already lost `orchestrated_by`;
 * they import it from here instead (the `SESSION_KINDS` precedent).
 *
 * Direction follows the stored or derived relation:
 *   - `blocked_by`      the waiting session → its blocker;
 *   - `spawned_from`    the child → the parent;
 *   - `orchestrated_by` the coordinated session → its orchestrator;
 *   - `waits_on_output` the session taking an output → the session producing it;
 *   - `triggered`       the session whose write fired a run → the run;
 *   - `updated`         the producer → the session that wrote to its output;
 *   - `serves`          the session → the GOAL (track) it works for; the only
 *                       kind whose far end is a goal, not a session.
 *
 * Zero imports: safe in browser, Electron, React Native, Node and CLI.
 */
export const WORK_GRAPH_EDGE_KINDS = [
  "blocked_by",
  "spawned_from",
  "orchestrated_by",
  "waits_on_output",
  "triggered",
  "updated",
  "serves",
] as const;
export type WorkGraphEdgeKind = (typeof WORK_GRAPH_EDGE_KINDS)[number];
