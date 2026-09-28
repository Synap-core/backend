/**
 * Preflight compose target — WHERE a package apply will layer its definition,
 * computed write-free so the preflight resolves profile slugs the way the apply
 * actually does.
 * ==========================================================================
 *
 * The live bug this exists for: `business-model` composes `foundation` and links
 * `offer → audience` (foundation's kinds, not re-declared). The pod preflight
 * only knew declared + system slugs, so it returned 422 on a package that the
 * publish validator (workspace-templates `validateTemplate`, which folds in the
 * compose base's vocabulary) had accepted — every overlay linking to its base's
 * kinds published green and could not be installed.
 *
 * Mirrors `materializeWorkspaceCore` step by step, reads only:
 *   1. `targetWorkspaceId` (`--onto`) wins over any declared compose dep —
 *      same precedence as materialize.
 *   2. A declared `compose` dep whose base the user already has (editor+,
 *      `findWorkspaceBySubtype` — the resolver's OWN lookup) → that workspace.
 *   Both return `{ workspaceId }`: the database preflight resolves undeclared
 *   slugs through that workspace's live lens, the same lookup reconcile's
 *   entityLink step falls back to.
 *   3. A declared `compose` dep whose base is NOT installed yet → the apply will
 *      install it from its template first. Return that template's vocabulary via
 *      the publish rule's own `collectBaseProfileSlugs`, fed ONLY compose edges:
 *      a compose base (and its own compose bases) all land in ONE workspace.
 *      `require` edges are deliberately excluded — a required base lives in its
 *      own workspace, and reconcile's lens sees its shared profiles only when an
 *      access row exists, so admitting them here would turn a loud 422 into a
 *      link the apply silently skips.
 *   No compose at all → `undefined`: the create door resolves declared + system
 *   slugs only, and so must the preflight.
 */

import type { PreflightComposeTarget } from "@synap/database";
import {
  collectBaseProfileSlugs,
  type WorkspaceYaml,
} from "@synap-core/workspace-templates";
import { findWorkspaceBySubtype } from "./package-dependency-resolver.js";
import { resolveWorkspaceTemplate } from "./capabilities/resolve-workspace-template.js";

interface DeclaredDependency {
  slug: string;
  kind?: string;
  relation?: string;
}

const isWorkspaceCompose = (d: DeclaredDependency): boolean =>
  (d.relation ?? "require") === "compose" &&
  (d.kind ?? "workspace") === "workspace";

export async function resolvePreflightComposeTarget(input: {
  definition: { dependencies?: DeclaredDependency[] };
  userId: string;
  targetWorkspaceId?: string;
}): Promise<PreflightComposeTarget | undefined> {
  if (input.targetWorkspaceId) return { workspaceId: input.targetWorkspaceId };

  const composeDep = (input.definition.dependencies ?? []).find(
    isWorkspaceCompose
  );
  if (!composeDep) return undefined;

  const existing = await findWorkspaceBySubtype(
    composeDep.slug,
    input.userId,
    true
  );
  if (existing) return { workspaceId: existing.id };

  // Base not installed: load its compose chain (read-only, cycle-guarded).
  const bases = new Map<string, WorkspaceYaml>();
  let next: string | undefined = composeDep.slug;
  while (next && !bases.has(next)) {
    const tpl = await resolveWorkspaceTemplate(next);
    if (!tpl) break; // unresolvable base → materialize surfaces it (422)
    const ownCompose = (tpl.dependencies as DeclaredDependency[]).find(
      isWorkspaceCompose
    );
    bases.set(next, {
      profiles: tpl.workspaceDefinition.profiles ?? [],
      dependencies: ownCompose
        ? [{ slug: ownCompose.slug, relation: "compose" }]
        : [],
    } as unknown as WorkspaceYaml);
    next = ownCompose?.slug;
  }

  const baseProfileSlugs = collectBaseProfileSlugs(
    {
      dependencies: [{ slug: composeDep.slug, relation: "compose" }],
    } as unknown as WorkspaceYaml,
    (slug) => bases.get(slug)
  );
  return { baseProfileSlugs: [...baseProfileSlugs] };
}
