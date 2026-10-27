/**
 * The work graph's window bounds — a LEAF module (no imports), so the MCP tool
 * schema (`routers/mcp/tools/index.ts`) and the doors can derive their limits
 * from it without loading the graph service and its database graph at tool
 * listing time. `work-graph.ts` re-exports them.
 */

/** Most window sessions one read returns (and, separately, most far ends). */
export const WORK_GRAPH_CEILING = 500;
/** Default window: open work + what settled in the last 72 h (decision D3). */
export const WORK_GRAPH_DEFAULT_WINDOW_HOURS = 72;
/** Longest window a caller may ask for (30 days). */
export const WORK_GRAPH_MAX_WINDOW_HOURS = 24 * 30;
