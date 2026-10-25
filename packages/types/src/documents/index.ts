/**
 * Document Types
 * Re-exports from database schema for frontend usage
 */

// Pure long-form-content heuristic — the single definition of "this is a
// document", shared by every writer surface (api capture/import + jobs worker).
export { shouldMaterializeAsDocument } from "./document-heuristic.js";

// Which property may become an entity's body document (text tiers, W3).
export {
  BODY_PROPERTY_SLUGS,
  isBodyPropertyDef,
  PROMOTE_TO_BODY_REFUSALS,
  UNDO_PROMOTE_TO_BODY_REFUSALS,
  type BodyPropertyDefLike,
  type PromoteToBodyRefusal,
  type UndoPromoteToBodyRefusal,
} from "./body-property.js";

// Document rows, declared in ./rows.js; @synap/database proves its inferred
// rows equal (packages/database/src/wire-parity/documents.ts). The Zod schemas
// live with the drizzle tables in @synap/database, not in this package.
export type {
  Document,
  NewDocumentVersion,
  DocumentSession,
  NewDocumentSession,
} from "./rows.js";
