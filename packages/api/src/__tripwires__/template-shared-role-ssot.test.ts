/**
 * TRIPWIRE — shared ecosystem roles are a single pod-wide SSOT.
 *
 * Ratified principle: the ecosystem role vocabulary (client, partner, sponsor,
 * lead, competitor, …) is defined ONCE (foundation.yaml) as `scope: shared`,
 * `profileKind: role`, and merely REFERENCED by every other template. The
 * template apply/dedup layer resolves a declared slug to the ONE pod-wide
 * profile — so if two templates declare the same shared slug with DIFFERENT
 * property bodies, they silently fight over one row (drift), and if a template
 * declares one of these role slugs as a `kind` or workspace-scoped, it forks a
 * second identity for a hat.
 *
 * This tripwire guards both failure modes at the source (the YAML → typed
 * template exports), so a regression is caught in CI instead of on a live pod.
 *
 *   (a) No template declares a shared-role slug as `profileKind: kind` or
 *       workspace-scoped.
 *   (b) No two templates declare the SAME property slug on the same `scope:
 *       shared` profile with DIFFERENT definitions (valueType / inputType /
 *       enumValues / defaultValue). EXTRA properties are ALLOWED.
 *
 * WHY (b) ALLOWS EXTRAS BUT FORBIDS CONFLICTS
 * -------------------------------------------
 * A shared profile is ONE pod-wide row. The apply engine
 * (`create-workspace-from-definition.ts`) seeds that row's pod-wide BASE
 * property body (workspace_id = NULL) from the template that CREATES it, and
 * adds a REUSING template's extra props as WORKSPACE OVERLAYS (workspace_id =
 * the reusing workspace). So:
 *
 *   - EXTRA props are the LEGITIMATE extension mechanism, not a violation.
 *     marketing's `lead-source`/`lead-score` are marketing's overlay on the
 *     shared `lead` base — they are invisible to sibling workspaces by design.
 *     The old rule ("identical or empty body") banned this outright and, to
 *     satisfy it, real content had to be deleted from templates and a real
 *     golden standard weakened. It over-prohibited.
 *
 *   - REDECLARING a prop the base already owns with a DIFFERENT definition IS a
 *     violation: both bodies target the same pod-wide row, so the surviving
 *     definition depends on apply order. That is base drift — the actual bug.
 *
 * WHAT MAKES EXTRAS SAFE: ORDERING IS NOW GUARANTEED BY CONSTRUCTION.
 * Extras are only sound if the BASE is deterministic. Previously foundation.yaml
 * was the declared SSOT but a dependency of NOTHING, so whichever template
 * applied FIRST seeded the base (marketing-first ⇒ the pod-wide `lead` base
 * became marketing's 10-prop body for every workspace). Every consumer of a
 * foundation-owned shared role now declares `relation: require` on `foundation`,
 * and `resolvePackageDependencies` installs dependencies deps-first BEFORE the
 * consumer's own workspace is materialized. The base is therefore always
 * foundation's body. That ordering guarantee is what lets this rule relax from
 * "identical-or-empty" to "no conflicts" without reopening the hole — the old
 * rule only "worked" by accidentally guarding the ordering gap.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// SOURCE, NOT THE INSTALLED TARBALL — where this data comes from is the whole
// point of this file.
//
// `@synap-core/workspace-templates` resolves to the last PUBLISHED tarball
// (0.5.0), which predates the role vocabulary entirely. Reading it made this
// tripwire assert against data that structurally CANNOT violate the rule, and a
// `describe.skipIf(packagePredatesRoleVocabulary)` then skipped the whole suite
// on that basis — so it guarded NOTHING while reporting green. A tripwire that
// reads a stale snapshot of the thing it guards is decoration.
//
// The templates are AUTHORED in synap-app; that source is the SSOT this rule is
// about, so we read it directly and fail on the real data.
//
// WHY A COMPUTED dynamic import rather than a static one: a static cross-repo
// import type-checks the imported tree as part of THIS project, which trips
// `rootDir` (TS6059/TS6307) and reds `packages/api` tsc. A computed specifier is
// opaque to tsc (typed `any`, never resolved) while vitest still transforms and
// loads the TS at runtime — the test reads real source without dragging another
// repo's tree into this package's compilation unit.
//
// TRADE-OFF (deliberate): this couples the backend test run to a synap-app
// checkout existing as a sibling. If it is absent we FAIL with an explicit
// message rather than skip — the correct outcome for a guard that cannot see its
// subject, and the opposite of the silent self-disabling it replaces.
const TEMPLATES_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../synap-app/packages/workspace-templates/src/templates.ts"
);

if (!existsSync(TEMPLATES_SRC)) {
  throw new Error(
    `template-shared-role-ssot tripwire cannot find the workspace-templates SOURCE at ${TEMPLATES_SRC}.\n` +
      `This guard reads synap-app source on purpose (the installed tarball is a stale published snapshot ` +
      `and reading it is what made this tripwire vacuous). Check out synap-app as a sibling of synap-backend. ` +
      `Do NOT "fix" this by repointing the import at @synap-core/workspace-templates.`
  );
}

const { listWorkspaceTemplates } = (await import(
  pathToFileURL(TEMPLATES_SRC).href
)) as { listWorkspaceTemplates: () => unknown[] };

/**
 * Structural view of a template profile. Declared locally (not imported) so the
 * tripwire compiles regardless of the `@synap-core/workspace-templates` d.ts
 * version — older published tarballs predate `profileKind`/`scope` on the
 * exported `TemplateProfile` type, but the runtime data (and current source)
 * carry them. We read the fields defensively.
 */
interface RoleProfileShape {
  slug: string;
  scope?: string;
  profileKind?: string;
  properties?: Array<{
    slug?: unknown;
    valueType?: unknown;
    inputType?: unknown;
    enumValues?: unknown;
    constraints?: { defaultValue?: unknown } | undefined;
  }>;
}

const profilesOf = (tpl: unknown): RoleProfileShape[] =>
  ((tpl as { profiles?: RoleProfileShape[] }).profiles ??
    []) as RoleProfileShape[];
const templateSlug = (tpl: unknown): string =>
  ((tpl as { meta?: { slug?: string } }).meta?.slug ?? "(unknown)") as string;

/** The shared ecosystem role vocabulary that must stay pod-wide roles. */
const SHARED_ROLE_SLUGS = new Set([
  "client",
  "partner",
  "sponsor",
  "lead",
  "competitor",
]);

const isSharedScope = (scope?: string): boolean =>
  (scope ?? "").toLowerCase() === "shared";
const isWorkspaceScope = (scope?: string): boolean => {
  // Omitted scope defaults to workspace-scoped.
  const s = (scope ?? "workspace").toLowerCase();
  return s === "workspace";
};
const normalizeKind = (k?: string): "kind" | "role" =>
  k === "role" ? "role" : "kind";

/**
 * Stable fingerprint of a SINGLE property's DEFINITION — the part that must not
 * differ between two templates declaring the same prop on the same shared row.
 * Presentation-only fields (label, placeholder) are excluded: they don't change
 * what the base column IS, so they are not drift.
 */
type PropShape = NonNullable<RoleProfileShape["properties"]>[number];
function propertyDefFingerprint(p: PropShape): string {
  return JSON.stringify({
    valueType: p.valueType ?? null,
    inputType: p.inputType ?? null,
    enumValues: Array.isArray(p.enumValues)
      ? [...(p.enumValues as string[])].sort()
      : null,
    defaultValue: p.constraints?.defaultValue ?? null,
  });
}

const templates = listWorkspaceTemplates();

// NO `skipIf`. The previous `skipIf(packagePredatesRoleVocabulary)` derived its
// own skip condition FROM the stale data it was reading — "no template declares
// a role, therefore this rule cannot be checked" — which is unfalsifiable: the
// suite auto-disabled itself in exactly the state a regression would produce.
// Reading source (above) removes the premise; the guard now always runs.
describe("workspace-templates — shared ecosystem role SSOT", () => {
  it("(a) never declares a shared-role slug as a kind or workspace-scoped profile", () => {
    const violations: string[] = [];
    for (const tpl of templates) {
      const tplSlug = templateSlug(tpl);
      for (const p of profilesOf(tpl)) {
        if (!SHARED_ROLE_SLUGS.has(p.slug)) continue;
        if (normalizeKind(p.profileKind) !== "role") {
          violations.push(
            `${tplSlug}: role slug '${p.slug}' declared as profileKind='${normalizeKind(
              p.profileKind
            )}' (must be 'role')`
          );
        }
        if (isWorkspaceScope(p.scope)) {
          violations.push(
            `${tplSlug}: role slug '${p.slug}' is workspace-scoped (scope='${
              p.scope ?? "workspace"
            }') — must be scope: shared`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("(b) never declares the same shared-profile property with CONFLICTING definitions across templates (extras are legal overlays)", () => {
    // sharedSlug → propSlug → defFingerprint → templates carrying it.
    // Two fingerprints for one (sharedSlug, propSlug) = two templates fighting
    // over ONE pod-wide column. Extra props (a propSlug only one template
    // declares) never produce a second fingerprint — they are overlays, legal.
    const defs = new Map<string, Map<string, Map<string, string[]>>>();
    for (const tpl of templates) {
      const tplSlug = templateSlug(tpl);
      for (const p of profilesOf(tpl)) {
        if (!isSharedScope(p.scope)) continue;
        const perProfile =
          defs.get(p.slug) ?? new Map<string, Map<string, string[]>>();
        for (const prop of p.properties ?? []) {
          const propSlug = String(prop.slug);
          const perProp =
            perProfile.get(propSlug) ?? new Map<string, string[]>();
          const fp = propertyDefFingerprint(prop);
          perProp.set(fp, [...(perProp.get(fp) ?? []), tplSlug]);
          perProfile.set(propSlug, perProp);
        }
        defs.set(p.slug, perProfile);
      }
    }

    const violations: string[] = [];
    for (const [slug, perProfile] of defs) {
      for (const [propSlug, perProp] of perProfile) {
        if (perProp.size <= 1) continue;
        const detail = [...perProp.entries()]
          .map(([fp, carriers]) => `[${carriers.join(", ")}] => ${fp}`)
          .join("  VS  ");
        violations.push(
          `shared '${slug}.${propSlug}' is declared with ${perProp.size} DIFFERENT definitions — ` +
            `they target the SAME pod-wide column, so the survivor depends on apply order (base drift): ${detail}`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
