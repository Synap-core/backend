/**
 * ensureTemplate — TEMPLATE-LIFECYCLE Contract B: an app says which template it
 * runs on, and the pod answers where that template stands — installed, missing,
 * retired, not in the catalog, or not knowable yet — and, when asked, installs
 * it through the governed install door.
 *
 * READ side only lives here (`readTemplateStanding`). The install itself is
 * the caller's: the tRPC `workspaces.ensureTemplate` procedure governs it
 * (`checkPermissionOrPropose`) and installs through `installFromCatalog`, so
 * there is ONE install door and the Hub mirror reaches it through the same
 * procedure. The definition ALWAYS comes from the catalog
 * (`resolveWorkspaceTemplate`), never from the caller.
 *
 * Catalog standing is template health's (`template-health.ts`), the ONE
 * authority: "not in the catalog" only after a provably COMPLETE template sync,
 * otherwise "unknown". An empty result and a failed read are different facts.
 */

import { and, db, eq, isNull, readTemplateState } from "@synap/database";
import { cpCatalogCache, workspaces } from "@synap/database/schema";
import { officialCatalogCondition } from "./capabilities/catalog-cache-query.js";
import { getWorkspaceTemplate } from "@synap-core/workspace-templates";
import {
  classifyTemplateLifecycle,
  resolveTemplateCatalog,
  templateHealthFor,
  type TemplateLifecycle,
} from "./template-health.js";
import { checkOneSpacePerDomain } from "./workspace-creation-service.js";

/** What an app shows for a template it needs. */
export interface EnsureTemplateCard {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
}

/** The door's answer (Contract B). */
export type EnsureTemplateResult =
  | {
      status: "installed";
      workspaceId: string;
      /** The installed version stamp; `null` = installed without one. */
      version: string | null;
      /** Behind the catalog's version (false when either side is unknown). */
      drifted: boolean;
      /** Catalog standing of the installed template (template health). */
      lifecycle: TemplateLifecycle;
      replacedBy: string | null;
    }
  | { status: "missing"; template: EnsureTemplateCard }
  | { status: "proposed"; proposalId: string; reviewUrl: string }
  | { status: "installing"; workspaceId: string }
  | { status: "retired"; replacedBy: string | null; reason: string | null }
  /**
   * A space of this template's domain already exists without the template's
   * identity (one space per domain). Same typed reply every create door gives.
   */
  | {
      status: "exists";
      workspaceId: string;
      workspaceName: string;
      guidance: string;
    }
  | { status: "not_in_catalog" }
  | { status: "unknown" };

/** Standing of a template that is not installed but can be. */
export interface AvailableTemplate {
  status: "available";
  template: EnsureTemplateCard;
}

/**
 * Where `slug` stands on this pod, for `userId`. Never installs, never writes.
 * `available` = installable and not installed: the caller decides between
 * reporting `missing` and installing.
 */
export async function readTemplateStanding(
  slug: string,
  userId: string
): Promise<EnsureTemplateResult | AvailableTemplate> {
  // Installed = an ACTIVE space holding the template's pod-wide identity.
  const [held] = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(and(eq(workspaces.packageSlug, slug), isNull(workspaces.archivedAt)))
    .limit(1);

  const catalog = await resolveTemplateCatalog([slug]);

  if (held) {
    const version = readTemplateState(held.settings)?.version ?? null;
    const health = templateHealthFor(slug, version, catalog, held.settings);
    return {
      status: "installed",
      workspaceId: held.id,
      version,
      drifted: health.drifted,
      lifecycle: health.lifecycle ?? "unknown",
      replacedBy: health.replacedBy,
    };
  }

  const standing = classifyTemplateLifecycle(slug, catalog);
  if (standing.lifecycle === "retired") {
    return {
      status: "retired",
      replacedBy: standing.replacedBy,
      reason: standing.retiredReason,
    };
  }
  if (standing.lifecycle === "unlisted") return { status: "not_in_catalog" };

  let template: EnsureTemplateCard | null = null;
  if (standing.lifecycle === "current") {
    const [row] = await db
      .select({
        name: cpCatalogCache.name,
        description: cpCatalogCache.description,
        definition: cpCatalogCache.definition,
      })
      .from(cpCatalogCache)
      .where(
        and(
          officialCatalogCondition(),
          eq(cpCatalogCache.kind, "template"),
          eq(cpCatalogCache.slug, slug),
          isNull(cpCatalogCache.retiredAt)
        )
      )
      .limit(1);
    if (row) {
      const def = (row.definition ?? {}) as {
        icon?: unknown;
        _meta?: { icon?: unknown };
      };
      const icon = def._meta?.icon ?? def.icon;
      template = {
        slug,
        name: row.name,
        description: row.description ?? null,
        icon: typeof icon === "string" ? icon : null,
      };
    }
  } else {
    // `unknown`: the catalog cache cannot answer (cold, or the last sync was
    // not provably complete). The pod's built-in copy of the catalog can still
    // install it — the same fallback `resolveWorkspaceTemplate` takes.
    const bundled = getWorkspaceTemplate(slug);
    if (bundled) {
      template = {
        slug,
        name: bundled.meta.name,
        description: bundled.meta.description ?? null,
        icon: bundled.meta.icon ?? null,
      };
    }
  }
  if (!template) return { status: "unknown" };

  // One space per domain: a live space of this domain without the template's
  // identity means installing would mint a twin. Answer it, never install.
  const domain = await checkOneSpacePerDomain({
    userId,
    packageSlug: slug,
    idempotencyKey: slug,
  });
  if (domain.action === "refuse") {
    return {
      status: "exists",
      workspaceId: domain.reply.workspaceId,
      workspaceName: domain.reply.workspaceName,
      guidance: domain.reply.guidance,
    };
  }

  return { status: "available", template };
}
