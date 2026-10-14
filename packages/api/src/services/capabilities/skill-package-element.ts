/**
 * The skill inside a skill package's catalog definition — the ONE unwrap both
 * the install door (`marketplace-install.ts`) and the update door
 * (`reconcile-standalone-configs-to-templates.ts`) read through.
 *
 * The catalog serves a skill package as `{ _meta, skill: {name, body, …} }`.
 * Read flat, every field is `undefined`: install then refused ("A skill needs
 * documentation or code"), and the update door read every managed field as
 * absent and reported "up to date (no drift)" for every skill, forever — so
 * `synap market update` printed "content changed" and then "not updated" on
 * each run (founder pod 2026-10-13, creative-director). A legacy flat
 * definition (no `skill` slot) is returned as is.
 */
export function skillElementOf(
  definition: Record<string, unknown>
): Record<string, unknown> {
  const skill = (definition as { skill?: unknown }).skill;
  return skill && typeof skill === "object" && !Array.isArray(skill)
    ? (skill as Record<string, unknown>)
    : definition;
}
