/**
 * Hub Protocol — entity UPDATE receipt (decision C5).
 *
 * The applied answer of hub `updateEntity` was `{ status: "updated", message:
 * "Entity updated", proposalId: undefined }`: no entity, no fields, the same
 * words whether the call changed a title or sent nothing at all. Raycast read
 * it as an entity and printed `Updated entity "undefined"`; the IS read it as
 * an unknown outcome (`requested`). This module names what LANDED.
 *
 * Pure (no db) so every door builds the same receipt from the same values —
 * the sibling of `buildCreateWriteReceipt` (write-receipt.ts) for updates.
 */

import type { UnmodeledProperty } from "@synap/database";

/** The patch a hub update call sends, in the hub's field names. */
export interface EntityUpdatePatch {
  title?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
  deleteProperties?: string[];
  profileSlug?: string;
  documentId?: string;
}

/** What an applied update wrote, named in the API's field words. */
export interface UpdateWriteReceipt {
  /**
   * `applied`: everything sent landed. `partial`: part of it was filed for
   * review instead (a status move into a reviewed status) — named in `proposed`.
   */
  state: "applied" | "partial";
  entityId: string;
  /**
   * The fields this call wrote: `title`, `description`, `documentId`,
   * `profileSlug`, `properties.<key>`, `removed.<key>`. Their stored values
   * are in the answer's `written`. A property key the kind does not model is
   * never listed here: it is in `properties.unmodeled`.
   */
  landed: string[];
  /** Fields filed for review instead of written (the status move). */
  proposed?: string[];
  /**
   * Present ONLY when the call sent property keys the kind does not model
   * (finding c161fd43). They are stored verbatim (flexible schema), but not
   * modelled, so not queryable — each with an optional `didYouMean`. The
   * same shape as the create receipt's `properties.unmodeled`.
   */
  properties?: { unmodeled: UnmodeledProperty[] };
}

/**
 * The unmodeled keys THIS patch sent. The repository validates the merged
 * bag, so its `unmodeled` also names keys an earlier write invented; a
 * receipt answers only for the keys the call carried. `entities.update`
 * (the one update door) applies it, so every update path (hub
 * `updateEntity`, MCP, Hub REST PATCH, the batch) reports the same keys.
 */
export function unmodeledOfPatch(
  unmodeled: readonly UnmodeledProperty[] | null | undefined,
  patchProperties: Record<string, unknown> | null | undefined
): UnmodeledProperty[] {
  if (!unmodeled?.length || !patchProperties) return [];
  return unmodeled.filter((u) => Object.hasOwn(patchProperties, u.key));
}

/** True when the patch would write nothing — refused, never "updated". */
export function isEmptyEntityPatch(patch: EntityUpdatePatch): boolean {
  return (
    patch.title === undefined &&
    patch.preview === undefined &&
    Object.keys(patch.metadata ?? {}).length === 0 &&
    (patch.deleteProperties?.length ?? 0) === 0 &&
    !patch.profileSlug &&
    !patch.documentId
  );
}

/** The refusal an empty patch gets — the same words on every door. */
export function emptyEntityPatchMessage(entityId: string): string {
  return `Nothing to update on entity ${entityId}: send at least one of title, description (preview), properties (metadata), deleteProperties, profileSlug or documentId. Nothing was written.`;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The receipt of an APPLIED update. A property whose stored value is not the
 * one sent while the call's status move was PROPOSED is the status move —
 * reported in `proposed`, never as landed. A key the kind does not model is
 * reported in `properties.unmodeled`, never as landed.
 */
export function buildUpdateWriteReceipt(input: {
  entityId: string;
  patch: EntityUpdatePatch;
  /** The row as the write left it (`entities.update`'s `written`). */
  writtenProperties: Record<string, unknown> | null | undefined;
  statusMoveProposed: boolean;
  /** `entities.update`'s `unmodeled`: the keys of this patch the kind does not model. */
  unmodeled?: readonly UnmodeledProperty[] | null;
}): UpdateWriteReceipt {
  const { patch } = input;
  const written = input.writtenProperties ?? {};
  const unmodeled = unmodeledOfPatch(input.unmodeled, patch.metadata);
  const unmodeledKeys = new Set(unmodeled.map((u) => u.key));
  const landed: string[] = [];
  const proposed: string[] = [];
  if (patch.title !== undefined) landed.push("title");
  if (patch.preview !== undefined) landed.push("description");
  if (patch.documentId) landed.push("documentId");
  if (patch.profileSlug) landed.push("profileSlug");
  for (const [key, value] of Object.entries(patch.metadata ?? {})) {
    if (unmodeledKeys.has(key)) continue;
    const held = sameValue(written[key], value);
    (input.statusMoveProposed && !held ? proposed : landed).push(
      `properties.${key}`
    );
  }
  for (const key of patch.deleteProperties ?? []) landed.push(`removed.${key}`);
  return {
    state: proposed.length > 0 ? "partial" : "applied",
    entityId: input.entityId,
    landed,
    ...(proposed.length > 0 ? { proposed } : {}),
    ...(unmodeled.length > 0 ? { properties: { unmodeled } } : {}),
  };
}
