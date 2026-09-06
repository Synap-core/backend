/**
 * Hub Protocol REST — GET /installed
 * ==================================
 *
 * THE ONE READ DOOR over the install ledgers this pod ALREADY MAINTAINS.
 *
 * WHY THIS IS A PROJECTION, NOT A NEW STORE. Five of the six package kinds have
 * carried a durable source-link for a while, written by the install doors and
 * consumed by the boot reconcilers:
 *
 *   | kind       | ledger                                                  |
 *   |------------|---------------------------------------------------------|
 *   | workspace  | `workspaces.package_slug` + `settings.packageVersion`    |
 *   |            | + `settings.installedPacks[]`                            |
 *   | capability | `capabilities.template_key` column (uq per scope, 0242)  |
 *   |            | + `metadata.contentHash` + `metadata.comparatorVersion`  |
 *   | view       | `metadata.marketSource` (slug, version, installedAt)     |
 *   | skill      | idem                                                     |
 *   | automation | idem                                                     |
 *   | cell       | `widget_definitions.type_key = "cell:<pkg>:<key>"`       |
 *   |            | + `version` (stamped at install — B3)                    |
 *
 * What did NOT exist was a read door: `market installed` asked Hub
 * `GET /workspaces` and nothing else, so it structurally reported 1 of 6 kinds
 * while its name claimed all of them. A dedicated `installed_packages` TABLE was
 * considered and REJECTED — a second store for facts four ledgers already hold
 * is the `settings.aiGovernance.autoApproveFor`-vs-`governance_rules` mistake
 * this codebase has already made once, and the ledgers stay authoritative
 * because the reconcilers read them. So: project, do not duplicate.
 *
 * ── THE ONE REAL DESIGN DECISION: CHEAP BY DEFAULT ─────────────────────────
 * `reconcileStandaloneConfigsToTemplates({dryRun:true})` is already a per-row
 * "installed + would-drift" report — but it fans out ONE Control-Plane fetch
 * PER SLUG with an 8s timeout, because the list-view `cp_catalog_cache` omits
 * the definition body for view/skill/automation. Wiring a LIST endpoint to it
 * unconditionally would make `market installed` do N network round-trips and
 * hang for 8s per cold slug.
 *
 * Therefore, explicitly:
 *   • DEFAULT (`?drift` absent/false) — pure local ledger read. No network at
 *     all. Every row reports slug, version, installedAt and identity. `drift`
 *     is reported ONLY where a LOCAL comparison can answer it honestly:
 *     workspaces (version stamp vs `cp_catalog_cache`, via the shared
 *     `template-health` authority). Every other kind reports `drift: null`,
 *     which means UNKNOWN — never `false`, because a `false` we did not
 *     compute is the "record it and return clean" lie this whole wave exists to
 *     remove.
 *   • `?drift=true` — additionally runs the standalone dry-run reconcile and
 *     upgrades view/skill/automation rows from `null` to a real verdict. Opt-in
 *     because it is the expensive mode.
 *
 * Access: scoped to the caller's accessible workspaces plus pod-global rows
 * (`workspace_id IS NULL`), the same lens `GET /workspaces` uses. This door
 * never widens.
 */

import { z } from "zod";
import { z as zOpenapi } from "@hono/zod-openapi";
import {
  db,
  and,
  eq,
  or,
  inArray,
  isNull,
  like,
  views,
  skills,
  automations,
  capabilities,
  workspaces,
} from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  templateHealthFor,
  resolveLatestVersionsBySlug,
} from "../../../services/template-health.js";
import { readMarketSource } from "../../../services/capabilities/market-source.js";
import { reconcileStandaloneConfigsToTemplates } from "../../../services/capabilities/reconcile-standalone-configs-to-templates.js";
import {
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";

/** Every kind this door can report. Mirrors the CP `PACKAGE_TYPES` install kinds. */
export const INSTALLED_KINDS = [
  "workspace",
  "capability",
  "view",
  "skill",
  "automation",
  "cell",
] as const;
export type InstalledKind = (typeof INSTALLED_KINDS)[number];

/** One installed row, kind-agnostic. */
export interface InstalledRow {
  kind: InstalledKind;
  /** The row's own id. For a cell this is its `type_key` (its natural key). */
  id: string;
  /** Display name. */
  name: string;
  /**
   * The CP package this row came from — the key `market update <slug>` takes —
   * or null when the row is not source-linked TO A PACKAGE.
   *
   * `null` for every `capability` row: a capability's durable source-link is a
   * TEMPLATE key (`capabilities.template_key`), which is not a package slug and
   * is not resolvable to one from this pod. It is reported under `templateKey`
   * below. Putting it here would hand a caller a slug that misses the catalog.
   */
  packageSlug: string | null;
  /**
   * The CP capability TEMPLATE this row converged to — `capability` rows only,
   * `null` for every other kind. Reconcile key for
   * `POST /api/hub/capabilities/reconcile`, NOT a catalog slug.
   */
  templateKey: string | null;
  /**
   * The version AS INSTALLED. `null` = unknown / never stamped.
   *
   * Semver for workspace / view / skill / automation. For `capability` it is the
   * CP template CONTENT HASH (the only version a capability install stamps) and
   * for `cell` the stamped widget version — neither is comparable to a semver,
   * which is why `latestVersion` stays `null` on those kinds rather than
   * inviting a string diff.
   */
  installedVersion: string | null;
  /** Freshest known catalog version, when locally knowable. `null` = unknown. */
  latestVersion: string | null;
  /**
   * Is this row behind its source?
   * `true`/`false` = COMPUTED. `null` = NOT COMPUTED (see the header's
   * cheap-by-default decision) — never a defaulted `false`.
   */
  drift: boolean | null;
  /** ISO install timestamp when the ledger records one. */
  installedAt: string | null;
  /** Owning workspace, or null for a pod-global row. */
  workspaceId: string | null;
  /**
   * INSTALL HEALTH — workspace rows only. Mirrors the three fields Hub
   * `GET /workspaces` projects: a workspace whose post-workspace layer failed is
   * `partial`, exists, is usable, and resumes on re-install. `null` = the
   * install completed (or the kind has no layered install).
   */
  provisioningStatus: string | null;
  failedStep: string | null;
  /**
   * Free-text note about WHY a field above is what it is — e.g. why drift is
   * unknown for this row. Never a status; always explanatory.
   */
  note?: string;
}

const ListInstalledQuerySchema = z.object({
  drift: z
    .enum(["true", "false"])
    .optional()
    .describe(
      "Opt into the EXPENSIVE drift pass for view/skill/automation rows (one Control-Plane fetch per distinct package slug). Default false: drift is reported only where a local comparison can answer it."
    ),
  kind: z.enum(INSTALLED_KINDS).optional().describe("Report only this kind."),
});

const InstalledRowSchema = zOpenapi
  .object({
    kind: zOpenapi.enum(INSTALLED_KINDS),
    id: zOpenapi.string(),
    name: zOpenapi.string(),
    packageSlug: zOpenapi
      .string()
      .nullable()
      .describe(
        "The CP package slug — the key `market update` takes. null when not package-source-linked, which includes EVERY capability row (see templateKey)."
      ),
    templateKey: zOpenapi
      .string()
      .nullable()
      .describe(
        "capability rows only: the CP template key this container converged to. Not a catalog slug."
      ),
    installedVersion: zOpenapi.string().nullable(),
    latestVersion: zOpenapi.string().nullable(),
    drift: zOpenapi
      .boolean()
      .nullable()
      .describe(
        "true/false = computed. null = NOT computed for this kind in this mode — never a defaulted false."
      ),
    installedAt: zOpenapi.string().nullable(),
    workspaceId: zOpenapi.string().nullable(),
    provisioningStatus: zOpenapi.string().nullable(),
    failedStep: zOpenapi.string().nullable(),
    note: zOpenapi.string().optional(),
  })
  .openapi("InstalledRow");

const ListInstalledResponseSchema = zOpenapi
  .object({
    installed: zOpenapi.array(InstalledRowSchema),
    /** Echoes whether the expensive drift pass actually ran. */
    driftComputed: zOpenapi.boolean(),
    counts: zOpenapi.record(zOpenapi.string(), zOpenapi.number()),
  })
  .openapi("ListInstalledResponse");

/**
 * `cell:<packageSlug>:<key>` → its package slug, or null when unparseable.
 *
 * The inverse of `packageCellTypeKey` (`services/cells/install-cell-from-definition.ts`),
 * the ONE minter of this key. That inverse is pinned by `installed.test.ts`,
 * which round-trips THROUGH the real minter rather than through a literal — an
 * import here would not have caught a format change.
 */
export function packageSlugFromCellTypeKey(typeKey: string): string | null {
  const parts = typeKey.split(":");
  if (parts.length < 3 || parts[0] !== "cell") return null;
  const slug = parts[1];
  if (!slug) return null;
  // `"unknown"` is a SENTINEL the install path writes, not a package name:
  // `marketplace-install.ts` builds the key from `def.packageSlug ?? "unknown"`
  // when a cell arrives without a source package. Returning it verbatim would
  // report `packageSlug: "unknown"` — a row that reads as a real package called
  // "unknown", and that a caller could try to look up. `null` already means
  // "not source-linked" everywhere else in this response; say that instead.
  if (slug === "unknown") return null;
  return slug;
}

export function registerInstalledRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/installed",
    tags: ["Packages"],
    summary: "List everything installed on this pod, per kind",
    description:
      "Unions the install ledgers that already exist — workspaces " +
      "(package_slug + version stamp), capability containers (template_key + " +
      "contentHash), the marketSource-linked view/skill/automation rows, and " +
      "package cells (cell:<pkg>:<key> + version). Cheap by default: no " +
      "network. Pass `drift=true` to additionally run the standalone dry-run " +
      "reconcile, which costs one Control-Plane fetch per distinct package " +
      "slug. `drift: null` on a row means NOT COMPUTED, never 'up to date'. " +
      "Requires hub-protocol.read scope.",
    request: { query: ListInstalledQuerySchema },
    responses: {
      200: {
        description: "Installed rows",
        schema: ListInstalledResponseSchema,
      },
      400: { description: "Invalid query", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/installed", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const parsed = ListInstalledQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const wantDrift = parsed.data.drift === "true";
    const onlyKind = parsed.data.kind;
    const wants = (k: InstalledKind) => !onlyKind || onlyKind === k;
    const userId = c.get("userId") as string;

    try {
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      /** The access lens every non-workspace kind uses: my workspaces + pod-global. */
      const scoped = <T extends { workspaceId: unknown }>(table: T) =>
        wsIds.length > 0
          ? or(
              inArray(
                table.workspaceId as Parameters<typeof inArray>[0],
                wsIds
              ),
              isNull(table.workspaceId as Parameters<typeof isNull>[0])
            )
          : isNull(table.workspaceId as Parameters<typeof isNull>[0]);

      const rows: InstalledRow[] = [];

      // ── workspace ────────────────────────────────────────────────────────
      if (wants("workspace") && wsIds.length > 0) {
        const wsRows = await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            settings: workspaces.settings,
            archivedAt: workspaces.archivedAt,
          })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds));
        const active = wsRows.filter((w) => w.archivedAt == null);
        const latestBySlug = await resolveLatestVersionsBySlug(
          active.map(
            (w) =>
              (w.settings as { packageSlug?: string } | null)?.packageSlug ?? ""
          )
        );
        for (const w of active) {
          const s = (w.settings ?? {}) as Record<string, unknown>;
          const slug = typeof s.packageSlug === "string" ? s.packageSlug : null;
          const installedPacks = Array.isArray(s.installedPacks)
            ? (s.installedPacks as unknown[])
            : [];
          // A workspace with NEITHER a packageSlug nor an additive pack was not
          // installed from anything — it is user-created, not an install.
          if (!slug && installedPacks.length === 0) continue;
          const installedVersion =
            typeof s.packageVersion === "string" ? s.packageVersion : null;
          const health = templateHealthFor(
            slug,
            installedVersion,
            latestBySlug
          );
          rows.push({
            kind: "workspace",
            id: w.id,
            name: w.name,
            packageSlug: slug,
            templateKey: null,
            installedVersion,
            latestVersion: health.latestVersion,
            // Locally computable for this kind — the version STAMP vs the
            // cached catalog version, through the shared authority so this door
            // can never disagree with `GET /workspaces` or MCP template_health.
            drift: health.drifted,
            installedAt: null,
            workspaceId: w.id,
            provisioningStatus:
              typeof s.provisioningStatus === "string"
                ? s.provisioningStatus
                : null,
            failedStep: typeof s.failedStep === "string" ? s.failedStep : null,
            ...(health.attached && !health.stamped
              ? {
                  note: "attached to a package but never version-stamped — drift cannot be computed",
                }
              : {}),
          });
        }
      }

      // ── capability containers ────────────────────────────────────────────
      if (wants("capability")) {
        const capRows = await db
          .select({
            id: capabilities.id,
            name: capabilities.name,
            workspaceId: capabilities.workspaceId,
            templateKey: capabilities.templateKey,
            metadata: capabilities.metadata,
          })
          .from(capabilities)
          .where(scoped(capabilities));
        for (const row of capRows) {
          const meta = (row.metadata ?? {}) as Record<string, unknown>;
          const templateKey =
            row.templateKey ??
            (typeof meta.templateKey === "string" ? meta.templateKey : null);
          if (!templateKey) continue; // not source-linked — not an install
          rows.push({
            kind: "capability",
            id: row.id,
            name: row.name,
            // NOT the templateKey. A capability container's source-link is a
            // CP TEMPLATE key, and there is no local mapping from it to the
            // catalog slug a caller would pass to `market update`. Reporting it
            // in a field named `packageSlug` invited exactly that call and a
            // catalog miss — `null` already means "not package-source-linked"
            // on every other row here. The key itself is reported below.
            packageSlug: null,
            templateKey,
            // A capability's "version" is the CP content hash of the template it
            // converged to — the same value `reconcileCapabilitiesToTemplates`
            // stamps and fast-paths on. NOT a semver; `latestVersion` stays null
            // so nothing string-diffs the two.
            installedVersion:
              typeof meta.contentHash === "string" ? meta.contentHash : null,
            latestVersion: null,
            // NOT COMPUTED. Resolving the current template hash is exactly the
            // per-slug Control-Plane fetch the capability reconcile does; this
            // door does not do it. `POST /api/hub/capabilities/reconcile`
            // with `{dryRun:true}` is the door that answers it.
            drift: null,
            installedAt: null,
            workspaceId: row.workspaceId,
            provisioningStatus: null,
            failedStep: null,
            note:
              typeof meta.comparatorVersion === "number"
                ? `contentHash stamped under drift comparator v${meta.comparatorVersion}; drift needs POST /capabilities/reconcile {dryRun:true}`
                : "no comparator version stamped (legacy) — this container re-diffs on the next reconcile",
          });
        }
      }

      // ── view / skill / automation (metadata.marketSource) ────────────────
      const standaloneSpecs = [
        { kind: "view" as const, table: views },
        { kind: "skill" as const, table: skills },
        { kind: "automation" as const, table: automations },
      ];
      for (const spec of standaloneSpecs) {
        if (!wants(spec.kind)) continue;
        const srcRows = await db
          .select({
            id: spec.table.id,
            name: spec.table.name,
            workspaceId: spec.table.workspaceId,
            metadata: spec.table.metadata,
          })
          .from(spec.table)
          .where(scoped(spec.table));
        for (const row of srcRows) {
          const source = readMarketSource(
            row.metadata as Record<string, unknown> | null | undefined
          );
          if (!source) continue; // not installed from a package
          rows.push({
            kind: spec.kind,
            id: row.id,
            name: row.name,
            packageSlug: source.packageSlug,
            templateKey: null,
            installedVersion: source.packageVersion,
            latestVersion: null,
            drift: null, // upgraded below when ?drift=true
            installedAt: source.installedAt || null,
            workspaceId: row.workspaceId,
            provisioningStatus: null,
            failedStep: null,
          });
        }
      }

      // ── cells ────────────────────────────────────────────────────────────
      if (wants("cell")) {
        const cellRows = await db
          .select({
            typeKey: widgetDefinitions.typeKey,
            name: widgetDefinitions.name,
            workspaceId: widgetDefinitions.workspaceId,
            version: widgetDefinitions.version,
            updatedAt: widgetDefinitions.updatedAt,
          })
          .from(widgetDefinitions)
          .where(
            and(
              // The namespaced install key `cell:<pkg>:<key>`, minted ONLY by
              // `installCellFromDefinition`. A generated / first-party widget
              // uses a different prefix and is correctly absent here.
              like(widgetDefinitions.typeKey, "cell:%"),
              scoped(widgetDefinitions),
              eq(widgetDefinitions.isActive, true)
            )
          );
        for (const row of cellRows) {
          const slug = packageSlugFromCellTypeKey(row.typeKey);
          rows.push({
            kind: "cell",
            // A cell's natural key IS its identity across both install doors —
            // report it as the id rather than the uuid, so a caller can match a
            // cell to its package without a second lookup.
            id: row.typeKey,
            name: row.name,
            packageSlug: slug,
            templateKey: null,
            // `widget_definitions.version` — stamped by both cell-install doors
            // (B3). The column DEFAULT is '1.0.0', so a row installed before
            // that stamp reads '1.0.0' and is indistinguishable from a genuine
            // 1.0.0. Reported as-is with the caveat below rather than guessed at.
            installedVersion: row.version,
            latestVersion: null,
            // Cells have NO reconciler and no comparator, so nothing can compute
            // drift for them today. `null` says exactly that.
            drift: null,
            installedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
            workspaceId: row.workspaceId,
            provisioningStatus: null,
            failedStep: null,
            note:
              row.version === "1.0.0"
                ? "version '1.0.0' may be the column default rather than a stamped package version (rows installed before the version stamp)"
                : undefined,
          });
        }
      }

      // ── OPT-IN drift pass for the three marketSource kinds ────────────────
      let driftComputed = false;
      if (wantDrift) {
        try {
          const report = await reconcileStandaloneConfigsToTemplates({
            dryRun: true,
          });
          // `updated` = fields WOULD advance ⇒ drifted. `ownerOwnedSkipped` =
          // the user edited a managed field ⇒ also divergent from the template,
          // and the honest answer to "is this row still what the package says"
          // is no. `skipped` includes "already up to date" AND "could not
          // resolve" — indistinguishable here, so those stay `null` rather than
          // being flattened into a false.
          const drifted = new Set<string>([
            ...report.updated.map((e) => e.id),
            ...report.ownerOwnedSkipped.map((e) => e.id),
          ]);
          const upToDate = new Set<string>(
            report.skipped
              .filter((e) => e.reason.includes("up to date"))
              .map((e) => e.id)
          );
          for (const row of rows) {
            if (
              row.kind !== "view" &&
              row.kind !== "skill" &&
              row.kind !== "automation"
            ) {
              continue;
            }
            if (drifted.has(row.id)) row.drift = true;
            else if (upToDate.has(row.id)) row.drift = false;
          }
          driftComputed = true;
        } catch (err) {
          // Never fail the LIST because the expensive optional pass failed —
          // the rows are still honest, they just keep `drift: null`.
          logger.warn(
            { err },
            "GET /installed: optional drift pass failed — rows keep drift:null"
          );
        }
      }

      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;

      return c.json({ installed: rows, driftComputed, counts });
    } catch (err) {
      logger.error({ err }, "GET /installed failed");
      return c.json({ error: "Failed to list installed packages" }, 500);
    }
  });
}
