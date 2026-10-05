/**
 * COMPILE-TIME COVERAGE FLOOR — every edge the graph can return has a zone.
 *
 * The node-neighbourhood role table (`@synap-core/types/connections`:
 * `LINK_EDGE_ROLES`, `RELATION_EDGE_ROLES`, `VIA_EDGE_ROLES`) lives in the
 * dependency-free types package, which cannot see the pod's own unions. This
 * file is where both are visible, so it pins each table's KEY SET to its
 * source union, both ways:
 *
 *   - `LinkType` (@synap/playbooks, lock-stepped with the links schema)
 *   - the default relation slugs (`DEFAULT_RELATION_DEFS`, `as const`)
 *     ∪ `SYSTEM_RELATION_TYPES`
 *   - `GraphNeighbor["via"]` (the read-time substrates of `getObjectGraph`)
 *
 * A new member on any side with no classification ⇒ the matching `_classified`
 * constant's type collapses to `never` ⇒ `tsc` stops the build. A classified
 * key whose source member was removed fails the same way (a zone for an edge
 * nobody can produce is a lie about the graph). The sets are DERIVED from the
 * unions — there is no third, hand-maintained list to fall behind.
 *
 * NOT covered (measured): workspace-defined relation slugs. They are data, not
 * a type; at runtime an unclassified slug reads as `related`.
 */

import type {
  LINK_EDGE_ROLES,
  RELATION_EDGE_ROLES,
  VIA_EDGE_ROLES,
} from "@synap-core/types/connections";
import type { LinkType } from "@synap/playbooks";
import type {
  DEFAULT_RELATION_DEFS,
  SYSTEM_RELATION_TYPES,
} from "@synap/database";
import type { GraphNeighbor } from "./graph-service.js";

/** `true` iff A and B are the same set of string literals; else `never`. */
type SameKeys<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never]
  ? true
  : never;

type RelationSlug =
  | (typeof DEFAULT_RELATION_DEFS)[number]["slug"]
  | (typeof SYSTEM_RELATION_TYPES)[number];

export const _linkTypesClassified: SameKeys<
  LinkType,
  keyof typeof LINK_EDGE_ROLES
> = true;

export const _relationSlugsClassified: SameKeys<
  RelationSlug,
  keyof typeof RELATION_EDGE_ROLES
> = true;

export const _viasClassified: SameKeys<
  GraphNeighbor["via"],
  keyof typeof VIA_EDGE_ROLES
> = true;
