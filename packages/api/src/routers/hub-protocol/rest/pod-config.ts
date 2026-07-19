/**
 * Hub Protocol REST — GET /pod/config
 *
 * READ-ONLY unified view of the pod's provisioning state, for the CLI's
 * "unified pod configuration" surface: every workspace the caller belongs to
 * (INCLUDING orphans — unstamped, ad-hoc workspaces), the pod's capabilities/
 * automations/playbooks with their scope (pod-wide vs workspace), and the
 * give/need `feeds` graph between workspaces.
 *
 * Provenance is entirely INFERRED from existing columns/settings — no schema
 * change, no new table. Reuses the same accessible-workspace lens
 * `getUserAccessibleWorkspaceIds` uses (mirrors `discover()`'s "include
 * orphans" behavior: a workspace is listed regardless of whether it was ever
 * stamped with a packageSlug), and the same subtype-match predicate
 * `findLegacyWorkspaceMatch` (workspace-creation-service.ts) uses for its
 * "does this workspace's subtype match a known template" check — mirrored
 * here in the opposite direction (template → orphan, not slug → workspace),
 * so an ad-hoc/orphan workspace can be told "this looks like the X template"
 * without ever writing anything.
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  entities,
  workspaces,
  capabilities,
  automations,
  playbooks,
  links,
  eq,
  and,
  or,
  isNull,
  inArray,
  drizzleSql,
  type WorkspaceSettings,
  type WorkspaceComposedFromEntry,
} from "@synap/database";
import { listWorkspaceTemplates } from "@synap-core/workspace-templates";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  getUserAccessibleWorkspaceIds,
  type HubHono,
} from "./_shared.js";

// ─── DTO ────────────────────────────────────────────────────────────────────

type WorkspaceProvenance =
  | { kind: "marketplace"; packageSlug: string; packageVersion: string | null }
  | { kind: "composed"; composedFrom: WorkspaceComposedFromEntry[] }
  | {
      kind: "ad-hoc";
      createdBy: string | null;
      /** Set only when an unstamped workspace's subtype matches a known template. */
      templateMatch?: { slug: string; name: string };
    };

interface PodConfigWorkspace {
  id: string;
  name: string;
  subtype: string | null;
  entityCount: number;
  provenance: WorkspaceProvenance;
}

interface PodConfigCapability {
  id: string;
  name: string;
  /** null = pod-wide, set = workspace-scoped. */
  workspaceId: string | null;
  provenance: { kind: "marketplace"; templateKey: string } | { kind: "manual" };
}

interface PodConfigAutomation {
  id: string;
  name: string;
  workspaceId: string | null;
  provenance: { kind: "ai" | "manual" | "template" };
}

interface PodConfigPlaybook {
  id: string;
  name: string;
  workspaceId: string | null;
  /** Playbooks carry no provenance signal (no templateKey/createdVia column). */
  provenance: { kind: "manual" };
}

interface PodConfigFeedsLink {
  from: string;
  to: string;
  domain: string | null;
  profileSlug: string | null;
}

interface PodConfigResponse {
  workspaces: PodConfigWorkspace[];
  capabilities: PodConfigCapability[];
  automations: PodConfigAutomation[];
  playbooks: PodConfigPlaybook[];
  feedsLinks: PodConfigFeedsLink[];
}

/**
 * Reverse of `findLegacyWorkspaceMatch`'s subtype predicate: given an
 * unstamped workspace's subtype, find a bundled template whose
 * `workspace.subtype` matches it exactly. Read-only — never writes, never
 * calls the CP (bundled templates only, same frozen set
 * `findLegacyWorkspaceMatch`'s subtype tier compares against).
 *
 * `subtype` is NOT a unique key across bundled templates (e.g. `crm` is
 * shared by both `business-developer` and `crm`; `ecosystem` by
 * `blockchain-ecosystem` and `ecosystem`; `operations` by `grants` and
 * `operations`) — a bare `.find()` silently picked whichever template
 * happened to be first, which could suggest a misleading match (e.g. "adopt
 * as business-developer" for a plain `crm`-subtype orphan). Tie-break:
 * prefer the template whose `meta.slug` equals the subtype exactly (the
 * canonical leaf template for that subtype). If no template's slug matches
 * exactly AND 2+ templates share the subtype, the match is genuinely
 * ambiguous — return no match rather than guess. A single unambiguous
 * subtype match is returned as before.
 */
function matchOrphanTemplate(
  subtype: string | null
): { slug: string; name: string } | undefined {
  if (!subtype) return undefined;
  const candidates = listWorkspaceTemplates().filter(
    (tpl) => tpl.workspace.subtype === subtype
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) {
    const match = candidates[0];
    return { slug: match.meta.slug, name: match.meta.name };
  }
  const exactSlugMatch = candidates.find((tpl) => tpl.meta.slug === subtype);
  if (exactSlugMatch) {
    return { slug: exactSlugMatch.meta.slug, name: exactSlugMatch.meta.name };
  }
  // 2+ candidates, none whose slug equals the subtype exactly — ambiguous.
  return undefined;
}

function deriveWorkspaceProvenance(
  settings: WorkspaceSettings | null,
  subtype: string | null
): WorkspaceProvenance {
  const packageSlug = settings?.packageSlug;
  if (packageSlug) {
    return {
      kind: "marketplace",
      packageSlug,
      packageVersion: settings?.packageVersion ?? null,
    };
  }
  const composedFrom = settings?.composedFrom;
  if (composedFrom && composedFrom.length > 0) {
    return { kind: "composed", composedFrom };
  }
  return {
    kind: "ad-hoc",
    createdBy: settings?.createdBy ?? null,
    templateMatch: matchOrphanTemplate(subtype),
  };
}

export function registerPodConfigRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/pod/config",
    tags: ["System"],
    summary:
      "Unified pod configuration — workspaces + capabilities/automations/playbooks + feeds graph",
    description:
      "Read-only DTO powering the CLI's unified pod-configuration view: every " +
      "workspace the caller belongs to (including unstamped orphans, with " +
      "inferred provenance), pod-wide + workspace-scoped capabilities/" +
      "automations/playbooks, and the workspace-to-workspace `feeds` graph.",
    responses: {
      200: {
        description: "Pod configuration",
        schema: z.record(z.string(), z.unknown()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/pod/config", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;

    try {
      // Accessible workspaces — memberships + pod-visible, INCLUDING orphans
      // (unstamped workspaces are never filtered out; same lens `discover()`
      // uses, so this DTO never under-reports relative to orient).
      const wsIds = await getUserAccessibleWorkspaceIds(userId);

      const [wsRows, countRows] = await Promise.all([
        wsIds.length
          ? db
              .select({
                id: workspaces.id,
                name: workspaces.name,
                settings: workspaces.settings,
              })
              .from(workspaces)
              .where(inArray(workspaces.id, wsIds))
          : Promise.resolve([]),
        wsIds.length
          ? db
              .select({
                workspaceId: entities.workspaceId,
                count: drizzleSql<number>`cast(count(*) as integer)`,
              })
              .from(entities)
              .where(
                and(
                  inArray(entities.workspaceId, wsIds),
                  isNull(entities.deletedAt)
                )
              )
              .groupBy(entities.workspaceId)
          : Promise.resolve([]),
      ]);
      const entityCountByWs = new Map(
        countRows.map((r) => [r.workspaceId, r.count])
      );

      const workspacesOut: PodConfigWorkspace[] = wsRows.map((w) => {
        const settings = (w.settings ?? null) as WorkspaceSettings | null;
        const subtype = settings?.workspaceSubtype ?? null;
        return {
          id: w.id,
          name: w.name,
          subtype,
          entityCount: entityCountByWs.get(w.id) ?? 0,
          provenance: deriveWorkspaceProvenance(settings, subtype),
        };
      });

      // Pod rows: workspaceId null (pod-wide) OR in the caller's accessible set.
      // `PgColumn`'s table-name is baked into its type, so a single generic
      // helper over a bare column doesn't typecheck across three tables —
      // inlined per table instead (same predicate each time).
      const podScopeCondition = (
        column:
          | typeof capabilities.workspaceId
          | typeof automations.workspaceId
          | typeof playbooks.workspaceId
      ) =>
        wsIds.length
          ? or(isNull(column), inArray(column, wsIds))!
          : isNull(column);

      const [capRows, autoRows, pbRows, feedsRows] = await Promise.all([
        db
          .select({
            id: capabilities.id,
            name: capabilities.name,
            workspaceId: capabilities.workspaceId,
            metadata: capabilities.metadata,
          })
          .from(capabilities)
          .where(podScopeCondition(capabilities.workspaceId)),
        db
          .select({
            id: automations.id,
            name: automations.name,
            workspaceId: automations.workspaceId,
            metadata: automations.metadata,
          })
          .from(automations)
          .where(podScopeCondition(automations.workspaceId)),
        db
          .select({
            id: playbooks.id,
            name: playbooks.name,
            workspaceId: playbooks.workspaceId,
          })
          .from(playbooks)
          .where(podScopeCondition(playbooks.workspaceId)),
        wsIds.length
          ? db
              .select({
                fromId: links.fromId,
                toId: links.toId,
                metadata: links.metadata,
              })
              .from(links)
              .where(
                and(
                  eq(links.linkType, "feeds"),
                  eq(links.fromType, "workspace"),
                  eq(links.toType, "workspace"),
                  or(inArray(links.fromId, wsIds), inArray(links.toId, wsIds))
                )
              )
          : Promise.resolve([]),
      ]);

      const capabilitiesOut: PodConfigCapability[] = capRows.map((r) => {
        const templateKey = (r.metadata as { templateKey?: string } | null)
          ?.templateKey;
        return {
          id: r.id,
          name: r.name,
          workspaceId: r.workspaceId,
          provenance: templateKey
            ? { kind: "marketplace", templateKey }
            : { kind: "manual" },
        };
      });

      const automationsOut: PodConfigAutomation[] = autoRows.map((r) => {
        const createdVia = (r.metadata as { createdVia?: string } | null)
          ?.createdVia;
        return {
          id: r.id,
          name: r.name,
          workspaceId: r.workspaceId,
          provenance: {
            kind:
              createdVia === "ai" || createdVia === "template"
                ? createdVia
                : "manual",
          },
        };
      });

      const playbooksOut: PodConfigPlaybook[] = pbRows.map((r) => ({
        id: r.id,
        name: r.name,
        workspaceId: r.workspaceId,
        provenance: { kind: "manual" },
      }));

      const feedsLinksOut: PodConfigFeedsLink[] = feedsRows.map((r) => {
        const metadata = (r.metadata ?? {}) as {
          domain?: string;
          profileSlug?: string | null;
        };
        return {
          from: r.fromId,
          to: r.toId,
          domain: metadata.domain ?? null,
          profileSlug: metadata.profileSlug ?? null,
        };
      });

      const response: PodConfigResponse = {
        workspaces: workspacesOut,
        capabilities: capabilitiesOut,
        automations: automationsOut,
        playbooks: playbooksOut,
        feedsLinks: feedsLinksOut,
      };

      return c.json(response);
    } catch (err) {
      logger.error({ err, userId }, "GET /pod/config failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
