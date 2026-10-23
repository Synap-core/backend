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
 *
 * The holder and the domain twin are found POD-WIDE (a template is installed
 * once per pod, a domain has one space), but the ANSWER names a space only
 * when the caller may see it: the person's floor (member, owner or
 * pod-visible) AND, for a scoped key, a grant that covers that space. A
 * hidden one is answered as if absent, and `heldOutOfSight` tells the install
 * door not to install (fence1, spec 17 §5.3).
 */

import {
  and,
  db,
  eq,
  getRequestGrant,
  isFullAccessGrant,
  isNull,
  readTemplateState,
  type KeyGrant,
} from "@synap/database";
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
import { validateWorkspaceAccess } from "../utils/workspace-membership.js";

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
  /**
   * A space the caller may not see holds the template or is its domain twin:
   * answered as `available`, but never installed (no second copy, no twin).
   * Never sent to the caller. Present only when true.
   */
  heldOutOfSight?: true;
}

/**
 * Does `grant` reach the space `workspaceId`? No grant (a session) or the
 * unbounded `*`: yes. Otherwise ONE scope that permits something and is not
 * pinned to a project or object, on every space (no list) or on this one. A
 * project- or object-pinned scope does not cover a whole space (fail closed).
 */
function grantCoversSpace(
  grant: KeyGrant | undefined,
  workspaceId: string
): boolean {
  if (!grant || isFullAccessGrant(grant)) return true;
  return grant.scopes.some(
    (scope) =>
      scope.permissions.length > 0 &&
      !scope.projectIds &&
      !scope.entityIds &&
      (!scope.workspaceIds || scope.workspaceIds.includes(workspaceId))
  );
}

/** May this request see `workspaceId`: the person's floor AND the key's grant. */
async function callerSeesSpace(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  if (!grantCoversSpace(getRequestGrant(), workspaceId)) return false;
  const readable = await validateWorkspaceAccess(userId, [workspaceId]);
  return readable.includes(workspaceId);
}

/**
 * Where `slug` stands on this pod, for `userId` (and the request's grant).
 * Never installs, never writes. `available` = installable and not installed
 * in a space the caller sees: the caller decides between reporting `missing`
 * and installing (never when `heldOutOfSight`).
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
  const heldOutOfSight = !!held && !(await callerSeesSpace(held.id, userId));

  const catalog = await resolveTemplateCatalog([slug]);

  if (held && !heldOutOfSight) {
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
    if (!(await callerSeesSpace(domain.reply.workspaceId, userId))) {
      return { status: "available", template, heldOutOfSight: true };
    }
    return {
      status: "exists",
      workspaceId: domain.reply.workspaceId,
      workspaceName: domain.reply.workspaceName,
      guidance: domain.reply.guidance,
    };
  }

  return heldOutOfSight
    ? { status: "available", template, heldOutOfSight: true }
    : { status: "available", template };
}
