/**
 * `@synap-core/types/whiteboard` — the contract of the whiteboard place door.
 *
 * - `resources.ts`: what a caller asks for (`PlaceOnBoardRequestSchema`, the
 *   one `BoardResourceRef` union), what it gets back, why it can be refused.
 * - `records.ts`: the tldraw 2.4.6 records a placement writes (pure builder),
 *   the frozen persisted names (shape types, meta keys, room and map names).
 * - `apply.ts`: what a write does to the records the board holds NOW (pure;
 *   the realtime server runs it on the live map).
 * - `fractional-index.ts`: tldraw's index key, "the one above".
 *
 * Consumers: the backend door (Hub `POST /whiteboards/:viewId/placements`,
 * MCP `synap_place_on_board`), the IS place tools, the browser (pending mark
 * and Approve / Reject on `meta.pending` shapes).
 */

export * from "./resources.js";
export * from "./records.js";
export * from "./apply.js";
export { indexAbove, isValidIndexKey } from "./fractional-index.js";
