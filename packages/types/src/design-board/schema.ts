/**
 * What a design may carry: per component, its declared props and their kind.
 * The ONE vocabulary the board validator (`parseBoard`), the op applier
 * (`applyOps`) and the catalog snapshot share. Moved from app-bases
 * `apps/ui-gallery/src/design/manifestToPuckConfig.ts` (plan 0fc746f4 §2.6),
 * where the Puck config builder still DERIVES it from the catalog; this file
 * only names its shape.
 */

export type FieldSpec =
  | { kind: "text"; multiline?: boolean }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "select"; options: string[] }
  /** `allow`: the only block types the slot takes (a label slot: inline blocks). Absent = any block. */
  | { kind: "slot"; allow?: string[] }
  | ListSpec;

/** A field of one item of a list prop. Inferred from story literals, so only these three kinds. */
export type ItemFieldSpec =
  { kind: "text" } | { kind: "number" } | { kind: "boolean" };

/**
 * A prop that takes an array of items (`options`, `tabs`, `items`). Docgen names
 * only the element type (`SpatialSelectOption[]`), never its fields, so the
 * item schema is DERIVED from the literal arrays the component's own stories
 * pass, never hand-listed per component.
 */
export interface ListSpec {
  kind: "list";
  item: Record<string, ItemFieldSpec>;
  /** Item fields every story example sets: an item without one is refused. */
  required: string[];
}

/** component name → declared prop → its kind. The ONLY props a design may carry. */
export type CanvasSchema = Record<string, Record<string, FieldSpec>>;
