/**
 * The element inside a catalog package definition — the ONE unwrap per kind.
 *
 * The Control Plane stores (and `GET /api/packages/:slug` serves) a skill or
 * capability package WRAPPED: `{ _meta, skill: {…} }` / `{ profiles,
 * description, capability: {…}, _meta }`. Its `/api/marketplace/capabilities`
 * feed (the pod's capability cache) serves the capability already unwrapped.
 * A consumer that can see BOTH shapes reads through these helpers; a legacy
 * flat definition is returned as is.
 */

import type { TemplateDependency } from "@synap/database";

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

/**
 * The capability inside a capability package's catalog definition — the
 * `skillElementOf` twin. The browser's install dialog hands `market.install`
 * the CP package definition it fetched (`{capability:{key,…}}`, RC4
 * payload-in), and a cache row without an inline definition re-fetches that
 * same wrapped body by slug. Read flat, `key`/`tools`/`skills` were all
 * `undefined` and the applier built a capability out of nothing. An already
 * unwrapped definition (the capability feed / cache) is returned as is.
 */
export function capabilityElementOf(definition: unknown): unknown {
  if (!definition || typeof definition !== "object") return definition;
  const capability = (definition as { capability?: unknown }).capability;
  return capability &&
    typeof capability === "object" &&
    !Array.isArray(capability)
    ? capability
    : definition;
}

/**
 * What a capability package `require`s present before it applies: the
 * package's own `dependencies` (on the wrapped CP package body, beside
 * `capability`), plus, for an ADD-ON, its base (`capability.extends`) when the
 * body does not list it. The catalog derives that same base dependency when it
 * publishes (`capabilityDependencies` in workspace-templates' catalog-lib); it
 * is derived again here because the capability feed the pod caches serves the
 * capability element alone, without the package's `dependencies`.
 *
 * Read by `market.install`'s capability branch, which hands them to the ONE
 * dependency resolver (`resolvePackageDependencies`).
 */
export function capabilityDependenciesOf(
  definition: unknown
): TemplateDependency[] {
  if (!definition || typeof definition !== "object") return [];
  const declared = (definition as { dependencies?: unknown }).dependencies;
  const deps: TemplateDependency[] = Array.isArray(declared)
    ? declared.filter(
        (d): d is TemplateDependency =>
          !!d &&
          typeof d === "object" &&
          typeof (d as { slug?: unknown }).slug === "string" &&
          (d as { slug: string }).slug.length > 0
      )
    : [];
  const element = capabilityElementOf(definition) as {
    extends?: unknown;
  } | null;
  const base =
    typeof element?.extends === "string" ? element.extends.trim() : "";
  const listed = deps.some(
    (d) => d.slug === base && (d.kind ?? "workspace") === "capability"
  );
  if (base && !listed) {
    deps.push({
      slug: base,
      kind: "capability",
      relation: "require",
      reason: `An add-on of ${base}: its actions run through ${base}'s access.`,
    });
  }
  return deps;
}
