/**
 * Workspace composition — resolve `definition.extends`.
 *
 * Wave 7 (D-E) of the browser UX north star (§10 composition): a workspace
 * definition can DECLARE that it imports/extends bricks (entity profiles +
 * typed views) from another SHARED/PUBLIC/SYSTEM workspace. "A content
 * workspace provides to others; a brand workspace provides templates."
 *
 * This module resolves those `extends` entries BEFORE the definition is
 * materialized by `createWorkspaceFromDefinition`, by:
 *   1. resolving each `source` ref (a workspaceId or a systemSlug) to a row,
 *   2. ACCESS-GATING the read — the caller may only import from a workspace
 *      they can see (member / pod_visible / pod_joinable / systemSlug). This
 *      is a cross-workspace read; getting it right is a leak-class concern.
 *   3. reading the source workspace's profiles (+ their base/overlay property
 *      defs) and views, converting them into the definition's own
 *      `profiles[]` / `views[]` shape so the existing materializer copies them.
 *
 * Copy-vs-reference: this slice uses COPY semantics (the importer gets its own
 * profile + property-def + view rows). Copy is safe and simple for V0; live
 * reference / re-sync to the provider is the dapp-ideal and is FLAGGED as a
 * follow-up (see north star §10). Conflicts on a profile/view that the importer
 * already declares are resolved importer-wins (the import is skipped + logged).
 *
 * Transitive `extends` (a source that itself extends another) is NOT followed —
 * one level only for this slice. Also FLAGGED as a follow-up.
 */

import { db, eq, and, drizzleSql } from "@synap/database";
import {
  workspaces,
  profiles,
  propertyDefs,
  views,
} from "@synap/database/schema";
import type {
  WorkspaceDefinitionInput,
  WorkspaceComposedFromEntry,
} from "@synap/database";
import { validateWorkspaceAccess } from "../utils/workspace-membership.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspace-composition" });

/** A single import directive on a workspace definition. */
export interface WorkspaceExtendsEntry {
  /** Source workspace: a workspaceId (uuid) or a systemSlug. */
  source: string;
  /** Which bricks to import. Omit a key (or the whole `import`) = import all. */
  import?: {
    profiles?: string[];
    views?: string[];
  };
}

export interface ResolveExtendsResult {
  /** The definition with imported profiles/views merged in. */
  definition: WorkspaceDefinitionInput;
  /** Provenance: what was imported from where (stamped into settings). */
  provenance: WorkspaceComposedFromEntry[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a `source` ref to a readable source workspace row.
 *
 * ACCESS GATE (the cross-workspace read-leak class): the caller may import from
 * a workspace only if it is one of:
 *   - a workspace they are a member of, OR
 *   - pod_visible / pod_joinable (via `validateWorkspaceAccess`), OR
 *   - a system workspace (`settings.systemSlug` set) — pod-wide readable.
 * Anything else resolves to `null` (the import is skipped, never throws).
 */
async function resolveReadableSource(
  source: string,
  userId: string
): Promise<{ id: string } | null> {
  // Resolve the ref → a candidate workspace row.
  const row = UUID_RE.test(source)
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, source),
        columns: { id: true, settings: true },
      })
    : await db.query.workspaces.findFirst({
        // systemSlug lives in settings JSONB.
        where: drizzleSql`${workspaces.settings}->>'systemSlug' = ${source}`,
        columns: { id: true, settings: true },
      });

  if (!row) return null;

  // System workspaces are pod-wide readable by any authenticated user.
  const systemSlug = (row.settings as Record<string, unknown> | null)
    ?.systemSlug;
  if (typeof systemSlug === "string" && systemSlug.length > 0) {
    return { id: row.id };
  }

  // Otherwise, the user must actually be able to see this workspace
  // (member OR pod_visible/pod_joinable). validateWorkspaceAccess returns the
  // intersection of {requested} and {visible to user} — never throws.
  const visible = await validateWorkspaceAccess(userId, [row.id]);
  return visible.includes(row.id) ? { id: row.id } : null;
}

/** Convert a source profile (+ its property defs) into a definition profile. */
function toDefinitionProfile(
  profile: typeof profiles.$inferSelect,
  defs: Array<typeof propertyDefs.$inferSelect>,
  slugById: Map<string, string>
): NonNullable<WorkspaceDefinitionInput["profiles"]>[number] {
  const uiHints = (profile.uiHints ?? {}) as Record<string, unknown>;
  return {
    slug: profile.slug,
    displayName: profile.displayName,
    icon: typeof uiHints.icon === "string" ? uiHints.icon : undefined,
    color: typeof uiHints.color === "string" ? uiHints.color : undefined,
    description:
      typeof uiHints.description === "string" ? uiHints.description : undefined,
    // System/shared profiles keep their scope so the materializer reuses the
    // existing global row; workspace-owned profiles are copied fresh.
    properties: defs.map((d) => {
      const dh = (d.uiHints ?? {}) as Record<string, unknown>;
      const constraints = (d.constraints ?? {}) as Record<string, unknown>;
      const enumValues = Array.isArray(constraints.enum)
        ? (constraints.enum as string[])
        : undefined;
      const targetSlug = d.targetProfileId
        ? slugById.get(d.targetProfileId)
        : undefined;
      return {
        slug: d.slug,
        label: typeof dh.displayName === "string" ? dh.displayName : d.slug,
        valueType: d.valueType,
        inputType: typeof dh.inputType === "string" ? dh.inputType : undefined,
        placeholder:
          typeof dh.placeholder === "string" ? dh.placeholder : undefined,
        enumValues,
        constraints,
        ...(targetSlug ? { targetProfileSlug: targetSlug } : {}),
      };
    }),
  };
}

/** Convert a source view row into a definition view. */
function toDefinitionView(
  view: typeof views.$inferSelect,
  slugById: Map<string, string>
): NonNullable<WorkspaceDefinitionInput["views"]>[number] | null {
  const scopeIds = view.scopeProfileIds ?? [];
  const scopeSlugs = scopeIds
    .map((id) => slugById.get(id))
    .filter((s): s is string => !!s);
  // A view we can't anchor to a known profile slug is dropped (its scope
  // profile wasn't imported) — the materializer would reject it anyway.
  if (scopeIds.length > 0 && scopeSlugs.length === 0) return null;

  const config = (view.config ?? {}) as Record<string, unknown>;
  const query = (view.query ?? {}) as Record<string, unknown>;
  return {
    name: view.name,
    type: view.type,
    scopeProfileSlug: scopeSlugs[0],
    scopeProfileSlugs: scopeSlugs.length > 1 ? scopeSlugs : undefined,
    config: { ...query, ...config },
    description: view.description ?? undefined,
  };
}

/**
 * Resolve `definition.extends` into merged profiles/views (copy semantics).
 *
 * Returns the definition with `extends` removed and imported bricks merged in,
 * plus a provenance list for `settings.composedFrom`. Never throws on an
 * unreadable / missing source — it skips and logs (best-effort composition).
 */
export async function resolveWorkspaceExtends(
  definition: WorkspaceDefinitionInput,
  userId: string
): Promise<ResolveExtendsResult> {
  const extendsList = definition.extends ?? [];
  if (extendsList.length === 0) {
    return { definition, provenance: [] };
  }

  // Importer's own bricks always win — track declared slugs/names.
  const ownProfileSlugs = new Set(
    (definition.profiles ?? []).map((p) => p.slug)
  );
  const ownViewNames = new Set(
    (definition.views ?? []).map((v) => v.name ?? v.displayName).filter(Boolean)
  );

  const importedProfiles: NonNullable<WorkspaceDefinitionInput["profiles"]> =
    [];
  const importedViews: NonNullable<WorkspaceDefinitionInput["views"]> = [];
  const provenance: WorkspaceComposedFromEntry[] = [];

  for (const entry of extendsList) {
    const resolved = await resolveReadableSource(entry.source, userId);
    if (!resolved) {
      logger.warn(
        { source: entry.source, userId },
        "extends: source not readable or not found — skipping import"
      );
      continue;
    }
    const sourceWorkspaceId = resolved.id;

    // ── Read source profiles (workspace-owned + shared/system used here). ──
    // We read profiles whose workspaceId is the source, plus shared/system
    // profiles are pulled by slug only when explicitly requested.
    const sourceProfiles = await db.query.profiles.findMany({
      where: eq(profiles.workspaceId, sourceWorkspaceId),
    });

    const wantProfiles = entry.import?.profiles;
    const selectedProfiles = wantProfiles
      ? sourceProfiles.filter((p) => wantProfiles.includes(p.slug))
      : sourceProfiles;

    // slug-by-id map for resolving entity_id targets + view scopes.
    const slugById = new Map<string, string>(
      sourceProfiles.map((p) => [p.id, p.slug])
    );

    const importedProfileSlugs: string[] = [];
    for (const profile of selectedProfiles) {
      if (ownProfileSlugs.has(profile.slug)) {
        logger.info(
          { source: entry.source, slug: profile.slug },
          "extends: profile conflict — importer wins, skipping import"
        );
        continue;
      }
      // Base defs for this profile (workspaceId NULL) + this source's overlays.
      const defs = await db.query.propertyDefs.findMany({
        where: and(
          eq(propertyDefs.profileId, profile.id),
          drizzleSql`(${propertyDefs.workspaceId} IS NULL OR ${propertyDefs.workspaceId} = ${sourceWorkspaceId})`
        ),
      });
      importedProfiles.push(toDefinitionProfile(profile, defs, slugById));
      ownProfileSlugs.add(profile.slug);
      importedProfileSlugs.push(profile.slug);
    }

    // ── Read source views (workspace-scoped). ──
    const sourceViews = await db.query.views.findMany({
      where: eq(views.workspaceId, sourceWorkspaceId),
    });
    const wantViews = entry.import?.views;
    const selectedViews = wantViews
      ? sourceViews.filter((v) => wantViews.includes(v.name))
      : sourceViews;

    const importedViewNames: string[] = [];
    for (const view of selectedViews) {
      if (ownViewNames.has(view.name)) {
        logger.info(
          { source: entry.source, name: view.name },
          "extends: view conflict — importer wins, skipping import"
        );
        continue;
      }
      const defView = toDefinitionView(view, slugById);
      if (!defView) continue;
      // Only import a view whose scope profile is actually present (own or
      // imported) — otherwise the materializer's cross-ref check rejects it.
      const scope = defView.scopeProfileSlug;
      if (scope && !ownProfileSlugs.has(scope)) continue;
      importedViews.push(defView);
      ownViewNames.add(view.name);
      importedViewNames.push(view.name);
    }

    provenance.push({
      sourceWorkspaceId,
      source: entry.source,
      profiles: importedProfileSlugs,
      views: importedViewNames,
      importedAt: new Date().toISOString(),
    });
  }

  // Imported bricks go FIRST so the importer's own declarations (appended
  // after) win on any residual ordering concern; conflicts already filtered.
  const merged: WorkspaceDefinitionInput = {
    ...definition,
    profiles: [...importedProfiles, ...(definition.profiles ?? [])],
    views: [...importedViews, ...(definition.views ?? [])],
  };
  delete merged.extends;

  return { definition: merged, provenance };
}
