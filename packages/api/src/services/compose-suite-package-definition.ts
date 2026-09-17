/**
 * composeSuitePackageDefinition — project uses-edges → one suite package.
 * ========================================================================
 *
 * Pure composition (no I/O). Given workspace `PackageDefinition`s already
 * serialised from a project's `uses` edges, emit ONE suite package shaped like
 * `enterprise-os`: `tags` include `suite`, `dependencies` `require` each
 * constituent workspace slug (NOT `compose` — re-apply must not duplicate
 * workspaces), and playbooks from those workspaces are embedded on the suite.
 *
 * This is NOT a new PACKAGE_TYPE — category stays `workspace`. The suite tag
 * is the headline signal (`SUITE_TAG` / `isSuite`).
 *
 * Loops are deliberately NOT invented here: a live workspace has no durable
 * loop row to reverse-serialise (`createLoopFromDefinition` dissolves into
 * playbooks + triggers). They stay on the exporter drop-list.
 */

import type {
  PackageDefinition,
  PackagePlaybook,
  TemplateDependency,
} from "@synap/database";

/** Tag that marks a package as a suite. Mirrors `@synap-core/marketplace`. */
export const SUITE_TAG = "suite" as const;

/** CP publish slug: `^[a-z][a-z0-9-]*$`. */
export function slugifyPackageName(name: string): string {
  const raw = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!raw) return "suite";
  return /^[a-z]/.test(raw) ? raw : `s-${raw}`;
}

export interface ComposeSuitePackageDefinitionInput {
  projectName: string;
  projectDescription?: string | null;
  /** Override slug; default = slugify(projectName). */
  slug?: string;
  /** Already-serialised workspace package definitions (one per uses-edge). */
  workspaceDefs: readonly PackageDefinition[];
}

/**
 * Compose a suite `PackageDefinition` from workspace defs.
 * Throws if there are no workspaces or a workspace lacks `_meta.slug`.
 */
export function composeSuitePackageDefinition(
  input: ComposeSuitePackageDefinitionInput
): PackageDefinition {
  if (input.workspaceDefs.length === 0) {
    throw new Error(
      "Cannot compose a suite: project uses no workspaces (no uses-edges)."
    );
  }

  const dependencies: TemplateDependency[] = [];
  const seenSlugs = new Set<string>();
  for (const def of input.workspaceDefs) {
    const slug = def._meta?.slug;
    if (!slug) {
      throw new Error(
        `Cannot compose a suite: workspace "${def.workspaceName ?? "(unnamed)"}" has no _meta.slug.`
      );
    }
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    dependencies.push({
      slug,
      kind: "workspace",
      // require, not compose — same as enterprise-os: each constituent is a
      // real workspace; re-apply reuses by slug instead of duplicating.
      relation: "require",
      reason: `Workspace lens required by the ${input.projectName} suite.`,
    });
  }

  // Embed playbooks from every constituent; first name wins so re-apply stays
  // idempotent (playbook reuse is by (workspaceId, name)).
  const playbooks: PackagePlaybook[] = [];
  const seenPlaybookNames = new Set<string>();
  for (const def of input.workspaceDefs) {
    for (const pb of def.playbooks ?? []) {
      if (seenPlaybookNames.has(pb.name)) continue;
      seenPlaybookNames.add(pb.name);
      playbooks.push(pb);
    }
  }

  const slug = input.slug ?? slugifyPackageName(input.projectName);
  const description =
    input.projectDescription?.trim() ||
    `Suite for ${input.projectName} — installs its used workspace lenses.`;

  const def: PackageDefinition = {
    _meta: {
      slug,
      tags: [SUITE_TAG],
    },
    workspaceName: input.projectName,
    description,
    dependencies,
    // CP publishSchema requires ≥1 profile for category:workspace. Depth lives
    // in the required workspace packages; this is the thin command-tower slot
    // (same role as enterprise-os's `objective`).
    profiles: [
      {
        slug: "suite-home",
        displayName: "Suite",
        description:
          "Command surface for this suite — depth lives in the required workspace packages.",
        properties: [
          {
            slug: "notes",
            label: "Notes",
            valueType: "string",
            inputType: "textarea",
          },
        ],
      },
    ],
  };

  if (playbooks.length > 0) def.playbooks = playbooks;
  return def;
}
