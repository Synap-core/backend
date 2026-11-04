/**
 * THE PROPERTY KEY — one rule for the key a value sits under in an entity's
 * property bag, shared by the door that MAKES keys and every door that NAMES
 * one later.
 *
 * Made: `slugifyPropertyKey` normalises every caller-supplied field slug
 * (define_kind / define_role, the approve-side reconciliation, the def edit
 * door) to a property-def slug: lowercase, words joined by `-`
 * (`contracts_total` → `contracts-total`).
 *
 * Named: the public exposure policy's `fields` allowlist, a site
 * collection's `slugField` and `sort` keys, and the public collection door's
 * `sort` parser read keys back by name. They used to carry their own grammar,
 * `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`, which refused the `-` the define door
 * writes: a multi-word field a kind defined could never be published (CP
 * ticket 5980e79d). They now derive from {@link PROPERTY_KEY_SOURCE}, which
 * accepts every slug `slugifyPropertyKey` makes (up to the def door's 100
 * characters) AND the camelCase / snake_case keys built-in kinds store
 * (`linkedinUrl`, `runStatus`, `last_seen`). The first character is a letter
 * or a digit, never `-`, so a `-` sort prefix stays unambiguous.
 *
 * Dependency-free: exported as `@synap/database/property-key` so the sharing
 * doors, which stay pure, read the SAME rule without loading the database
 * client. Tripwire: `property-key.test.ts` (every slug the slugifier makes is
 * a key) and api `sharing/__tests__/property-key-grammar.test.ts` (each
 * sharing door accepts what define_kind stores).
 */

/** The longest property-def slug `property-defs.create` accepts. */
export const PROPERTY_KEY_MAX_LENGTH = 100;

/** The key grammar, unanchored, for doors that embed it (a `-?` sort prefix). */
export const PROPERTY_KEY_SOURCE = `[A-Za-z0-9][A-Za-z0-9_-]{0,${PROPERTY_KEY_MAX_LENGTH - 1}}`;

/** A whole property key. */
export const PROPERTY_KEY_PATTERN = new RegExp(`^${PROPERTY_KEY_SOURCE}$`);

/**
 * Normalize a free-form label to a property-def slug (`/^[a-z0-9-]+$/`, the slug
 * regex property-defs.create enforces). `Geo`→`geo`, `Funding Amount`→`funding-amount`,
 * `Score!!`→`score`. Returns `""` when nothing slug-able remains (caller keeps
 * the value under its original key in that case).
 */
export function slugifyPropertyKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
