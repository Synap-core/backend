/**
 * ONE predicate for "this record was replaced by a newer one".
 *
 * `supersededBy` is an `entity_id` property: the global def belongs to
 * `decision`, and `knowledge` carries its own profile-scoped def that targets
 * `knowledge` (`@synap/database` ensure-system-profiles). A template or a
 * `synap_define_kind` may give any other kind the same slug. The predicate is
 * therefore keyed on the PROPERTY, never on the kind: a per-kind list would be
 * a hand-maintained twin of the defs the pod already holds.
 *
 * Key-shape tolerant on purpose, like `lastVerifiedAt` in
 * `describeItemProvenance` (synthesize.ts): `slugifyPropertyKey` stores a
 * camelCase slug declared through `synap_define_kind` as `supersededby`, and a
 * writer may use a hyphenated variant. Reading one spelling would make the
 * replacement look unset.
 *
 * Returns the REPLACEMENT's id, or null when the record is current. An empty
 * or non-string value is not a pointer and does not supersede anything.
 */
export function supersededByOf(rec: Record<string, unknown>): string | null {
  const props = rec.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (k.toLowerCase().replace(/[-_]/g, "") !== "supersededby") continue;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
