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
 *   (b) Every slug declared `scope: shared` carries an IDENTICAL property body
 *       across all templates, OR an empty-reference body (properties: []) — the
 *       SSOT-plus-references shape.
 */

import { describe, expect, it } from "vitest";
import { listWorkspaceTemplates } from "@synap-core/workspace-templates";

/**
 * Structural view of a template profile. Declared locally (not imported) so the
 * tripwire compiles regardless of the installed `@synap-core/workspace-templates`
 * d.ts version — older published tarballs predate `profileKind`/`scope` on the
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
    enumValues?: unknown;
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

/** Stable, order-insensitive fingerprint of a profile's property body. */
function propertyFingerprint(
  properties: RoleProfileShape["properties"]
): string {
  const props = properties ?? [];
  const norm = props
    .map((p) => ({
      slug: p.slug,
      valueType: p.valueType,
      enumValues: Array.isArray(p.enumValues)
        ? [...(p.enumValues as string[])].sort()
        : undefined,
    }))
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return JSON.stringify(norm);
}

const templates = listWorkspaceTemplates();

/**
 * The installed `@synap-core/workspace-templates` may be a STALE published
 * tarball that predates the Kind+Facets role vocabulary (no `profileKind` on any
 * profile). Enforcing the SSOT rule against pre-vocabulary data is meaningless —
 * so we auto-skip until the package is republished from current source (a known
 * deploy prerequisite: "republish @synap-core/workspace-templates first"). Once
 * republished, this activates and enforces the rule (and will surface any
 * remaining template-side violations for the template owner to fix).
 */
const packagePredatesRoleVocabulary = !templates.some((tpl) =>
  profilesOf(tpl).some((p) => normalizeKind(p.profileKind) === "role")
);

describe.skipIf(packagePredatesRoleVocabulary)(
  "workspace-templates — shared ecosystem role SSOT",
  () => {
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

    it("(b) keeps every shared slug's property body identical (or empty-reference) across templates", () => {
      // slug → set of non-empty fingerprints seen (with the templates that carry them)
      const bodies = new Map<string, Map<string, string[]>>();
      for (const tpl of templates) {
        const tplSlug = templateSlug(tpl);
        for (const p of profilesOf(tpl)) {
          if (!isSharedScope(p.scope)) continue;
          const props = p.properties ?? [];
          if (props.length === 0) continue; // empty-reference — always allowed
          const fp = propertyFingerprint(props);
          const perSlug = bodies.get(p.slug) ?? new Map<string, string[]>();
          const carriers = perSlug.get(fp) ?? [];
          carriers.push(tplSlug);
          perSlug.set(fp, carriers);
          bodies.set(p.slug, perSlug);
        }
      }

      const violations: string[] = [];
      for (const [slug, fps] of bodies) {
        if (fps.size > 1) {
          const detail = [...fps.values()]
            .map((carriers) => `[${carriers.join(", ")}]`)
            .join(" vs ");
          violations.push(
            `shared slug '${slug}' has ${fps.size} DIFFERENT property bodies across templates: ${detail}`
          );
        }
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });
  }
);
