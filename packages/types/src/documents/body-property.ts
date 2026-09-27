/**
 * Which PROPERTY may become an entity's body document ("Open as document").
 *
 * An entity has at most one body (`entities.document_id` is a single FK), so
 * only the property that IS the body may escalate from an inline field (Tier 1)
 * to a document (Tier 2): the conventional content slugs, or a property that
 * declares `uiHints.displayAs: "body"`. Every other long-text property keeps the
 * inline field as its ceiling (text tiers §3, founder decision a).
 *
 * ONE rule, read by the pod's promote door (`promotePropertyToBody`) AND by the
 * web affordance that offers it — so the button is never shown for a property
 * the door would refuse. Pure, dependency-free.
 */

/** The conventional body slugs (the ones `NoteDetailRenderer` treats as content). */
export const BODY_PROPERTY_SLUGS: readonly string[] = ["content", "body"];

export interface BodyPropertyDefLike {
  slug: string;
  uiHints?: { displayAs?: unknown } | Record<string, unknown> | null;
}

/** True when this property may be moved into its entity's body document. */
export function isBodyPropertyDef(def: BodyPropertyDefLike): boolean {
  if (BODY_PROPERTY_SLUGS.includes(def.slug)) return true;
  const hints = def.uiHints as { displayAs?: unknown } | null | undefined;
  return hints?.displayAs === "body";
}

/**
 * Why the promote door refused — a stable code, so a surface can branch without
 * matching prose.
 *   - `not_body_property` — the property is not the entity's body (see above).
 *   - `empty_value`       — nothing to move.
 *   - `body_exists`       — the entity already has a body document; moving a
 *                           second text into it would merge two bodies.
 *   - `agent_caller`      — the door is a person's gesture; agents write the body
 *                           through `update_document` after it exists.
 */
export const PROMOTE_TO_BODY_REFUSALS = [
  "not_body_property",
  "empty_value",
  "body_exists",
  "agent_caller",
] as const;
export type PromoteToBodyRefusal = (typeof PROMOTE_TO_BODY_REFUSALS)[number];

/**
 * Why an undo of a promotion was refused.
 *   - `edited_since` — the document was edited after the move; undoing would
 *                      throw that work away.
 *   - `not_promoted` — this document was not created by a promotion of this
 *                      entity (or the link has since changed).
 */
export const UNDO_PROMOTE_TO_BODY_REFUSALS = [
  "edited_since",
  "not_promoted",
] as const;
export type UndoPromoteToBodyRefusal =
  (typeof UNDO_PROMOTE_TO_BODY_REFUSALS)[number];
