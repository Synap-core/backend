/**
 * THE effective relation-type vocabulary for a lens — one read, one rejection.
 *
 * Every door that accepts a relation `type` answers the same two questions:
 * "which slugs resolve here?" and "what do I tell a caller who sent one that
 * does not?". Before this module the answers forked: `relations.create` threw
 * "Unknown relation type" with no list, while capture's text lane silently
 * COERCED an unknown slug to `relates_to` — the edge landed with the wrong type
 * and nobody was told. An agent had no door that listed the slugs at all.
 *
 * - READ: `RelationDefRepository.list(workspaceId)` — that workspace's defs plus
 *   the pod-wide base layer (`null` ⇒ base layer only). Listing doors
 *   (`synap_list_profiles`, `/api/hub/discover`) and validators read through
 *   here, so what an agent is shown and what a write accepts cannot disagree.
 * - ACCEPT: the listed def slugs ∪ `SYSTEM_RELATION_TYPES` ∪
 *   `IMPACT_RELATION_TYPES` — exactly what `relations.create` accepts.
 * - REJECT: `unknownRelationTypeMessage` names the offending slug AND the valid
 *   def slugs of the lens. Never coerce.
 */

import {
  RelationDefRepository,
  SYSTEM_RELATION_TYPES,
  type RelationDef,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "relation-types" });

/**
 * Generic built-in relation types introduced by "impact-aware writes". These
 * are accepted by `create` WITHOUT a workspace relation-def (like
 * SYSTEM_RELATION_TYPES) so the entity-create handler can auto-connect
 * same-named facets across profiles. Kept deliberately generic.
 *
 * - `same_subject`: two entities (different profiles, same name) are facets of
 *   one real-world subject — e.g. a `person` and a `company` both named "Acme".
 */
export const IMPACT_RELATION_TYPES = ["same_subject"] as const;

type RelationDefDb = ConstructorParameters<typeof RelationDefRepository>[0];

/** One relation type as an agent-facing listing reports it. */
export interface EffectiveRelationType {
  slug: string;
  displayName: string;
  description: string | null;
  isDirectional: boolean;
  /** `uiHints.inverseLabel` when the def carries one. */
  inverseLabel: string | null;
  /** `null` = pod-wide base layer; a string = defined by that workspace. */
  workspaceId: string | null;
}

/** Built-ins `relations.create` accepts without a def (not user-facing). */
export function isBuiltinRelationType(slug: string): boolean {
  return (
    (SYSTEM_RELATION_TYPES as readonly string[]).includes(slug) ||
    (IMPACT_RELATION_TYPES as readonly string[]).includes(slug)
  );
}

function toEffective(def: RelationDef): EffectiveRelationType {
  const hints = (def.uiHints ?? {}) as { inverseLabel?: unknown };
  return {
    slug: def.slug,
    displayName: def.displayName,
    description: def.description ?? null,
    isDirectional: def.isDirectional,
    inverseLabel:
      typeof hints.inverseLabel === "string" ? hints.inverseLabel : null,
    workspaceId: def.workspaceId ?? null,
  };
}

/**
 * The relation defs that resolve under `workspaceId` (base layer when null),
 * one row per slug — a workspace override wins over the base def of the same
 * slug, mirroring `RelationDefRepository.getBySlug`. Sorted by slug.
 *
 * THROWS on a failed read. A failed read is not an empty vocabulary; callers
 * decide how to surface it.
 */
export async function listEffectiveRelationTypes(
  database: RelationDefDb,
  workspaceId: string | null
): Promise<EffectiveRelationType[]> {
  const defs = await new RelationDefRepository(database).list(workspaceId);
  const bySlug = new Map<string, EffectiveRelationType>();
  for (const def of defs) {
    const existing = bySlug.get(def.slug);
    if (!existing || (existing.workspaceId === null && def.workspaceId)) {
      bySlug.set(def.slug, toEffective(def));
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** THE wording for an unknown relation slug — names it and lists the valid ones. */
export function unknownRelationTypeMessage(
  slug: string,
  validSlugs: readonly string[]
): string {
  const list =
    validSlugs.length > 0
      ? `Valid relation types for this lens: ${validSlugs.join(", ")}.`
      : "No relation types are defined for this lens.";
  return `Unknown relation type: "${slug}". ${list} Relation types are listed by synap_list_profiles (relationTypes) and GET /api/hub/discover (relationTypes).`;
}

/** An unknown slug, carried as data so a door can render it without re-parsing. */
export class UnknownRelationTypeError extends Error {
  constructor(
    readonly slug: string,
    readonly validSlugs: readonly string[]
  ) {
    super(unknownRelationTypeMessage(slug, validSlugs));
    this.name = "UnknownRelationTypeError";
  }
}

/**
 * A validator for many edges under one lens (avoids N+1): returns the slug
 * unchanged when it resolves, THROWS `UnknownRelationTypeError` when it does
 * not. Designed for the per-edge `try` of `createRelationsFromRefs`, so an
 * unknown slug fails ITS edge alone and lands in `relationsFailed[]`.
 *
 * A failed defs read does NOT fold into a calm fallback vocabulary: it is
 * logged at error, and every edge validated through the returned function
 * fails with a reason naming the read failure — the same `relationsFailed[]`
 * channel the capture receipts already report partial writes through.
 */
export async function loadRelationTypeValidator(
  database: RelationDefDb,
  workspaceId: string | null
): Promise<(slug: string) => string> {
  let types: EffectiveRelationType[];
  try {
    types = await listEffectiveRelationTypes(database, workspaceId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, workspaceId },
      "relation defs could not be read — every edge in this batch fails with the read error"
    );
    return () => {
      throw new Error(
        `Relation types could not be read for this lens (${detail}), so the edge was not created. Retry the capture.`
      );
    };
  }
  const validSlugs = types.map((t) => t.slug);
  const accepted = new Set(validSlugs);
  return (slug: string) => {
    if (accepted.has(slug) || isBuiltinRelationType(slug)) return slug;
    throw new UnknownRelationTypeError(slug, validSlugs);
  };
}
