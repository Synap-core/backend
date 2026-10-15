/**
 * Marketplace — what the console reads off a catalog definition.
 *
 * The catalog itself is the POD's (`marketplace.*` over its synced
 * `cp_catalog_cache`); the console never talks to a catalog source. It never
 * surfaces a "verified" badge (a typosquat has become `isVerified` by
 * registering a domain) and never displays or ranks by install count — that
 * counter is bumped by an unauthenticated, non-idempotent endpoint, so it is
 * an attacker-writable integer, not social proof.
 */

/**
 * The subset of a package definition Pod Admin reads to describe an install.
 * Everything is optional: a definition is authored data, and a `capability`
 * package carries almost none of these keys.
 */
export interface PackageDefinition {
  workspaceName?: string;
  description?: string;
  profiles?: unknown[];
  views?: unknown[];
  capabilities?: unknown[];
  automations?: unknown[];
  playbooks?: unknown[];
  cells?: unknown[];
  suggestedEntities?: unknown[];
  entityLinks?: unknown[];
  relationDefs?: unknown[];
  commands?: unknown[];
  dependencies?: { slug: string; kind?: string; relation?: string }[];
  workspaceCapabilities?: string[];
  [key: string]: unknown;
}

/**
 * Catalog descriptions are author-written and some were written for US, not for
 * an operator: 9 of the 53 live rows carry `GOTCHA:`, `packages/`, `src/` or a
 * "do NOT do this yet" note. Rendering them raw puts engineering notes on an
 * operator's decision surface.
 *
 * `synap-landing/app/superpowers/lib/description.ts` holds the twin of this
 * list and must stay in step. It is duplicated rather than shared because the
 * landing site is NOT in this pnpm workspace — it consumes `@synap-core/*` as
 * pinned npm versions — so there is no module both can import. That is a
 * packaging constraint, not a preference; if the landing ever joins the
 * workspace, delete this copy.
 */
const INTERNAL_MARKERS = [
  "GOTCHA",
  "PRECONDITION",
  "POST-SIGNOFF",
  "TODO",
  "packages/",
  "src/",
  ".ts",
];

/**
 * The description if it was written for a reader, otherwise null.
 *
 * Returns null rather than a scrubbed string on purpose: a description with an
 * internal marker in it is not "mostly fine with a bad word" — it is a note
 * about our build. Truncating it would keep the opening sentence and hide the
 * marker, which is worse: the operator then reads engineering shorthand with no
 * signal that anything was removed.
 */
export function readableDescription(
  description?: string | null
): string | null {
  const text = description?.trim();
  if (!text) return null;
  return INTERNAL_MARKERS.some((m) => text.includes(m)) ? null : text;
}
