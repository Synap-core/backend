/**
 * Define (upsert) a cell from raw renderer source — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH for the "AI-generated cell" create path, used by BOTH
 * the Hub REST route (`POST /cells/define`) AND the MCP `synap_create_cell`
 * verb. Idempotent upsert on (typeKey, workspaceId); when workspaceId is omitted
 * the cell is pod-global (visible in all workspaces). Emits the
 * widget_definition change so connected browsers refresh live.
 */

import { getDb, and, eq, isNull } from "@synap/database";
import { execFieldsChanged } from "../capabilities/skill-exec-fields.js";
import { widgetDefinitions } from "@synap/database/schema";
import type { ContentKind } from "@synap/database/schema";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";

// deps are spliced into esm.sh import-map URLs inside the sandboxed iframe
// (cell-runtime ViewFrame) — the regexes are what stops a crafted name/version
// from manipulating the request path/query (CSP pins the origin, not the path).
// Enforced HERE, inside the one door, so no caller (route, MCP, marketplace
// install, future) can reach the upsert with unvalidated deps.
const NPM_PKG_NAME_RE =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_VERSION_RE = /^[a-zA-Z0-9^~><= .*|-]{1,64}$/;

/** Returns an error message, or null when valid. */
export function validateDeps(
  deps: Record<string, string> | undefined
): string | null {
  if (!deps) return null;
  const entries = Object.entries(deps);
  if (entries.length > 30) return "deps must have at most 30 entries";
  for (const [pkg, version] of entries) {
    if (!NPM_PKG_NAME_RE.test(pkg)) {
      return `Invalid package name in deps: "${pkg}"`;
    }
    if (!NPM_VERSION_RE.test(version)) {
      return `Invalid version string for "${pkg}": "${version}"`;
    }
  }
  return null;
}

export interface DefineCellInput {
  name: string;
  rendererSource: string;
  /** Omit / null → pod-global cell (workspaceId IS NULL). */
  workspaceId?: string | null;
  /** Explicit typeKey; defaults to `generated:${slug(name)}`. */
  typeKey?: string;
  description?: string | null;
  defaultSize?: { w: number; h: number };
  deps?: Record<string, string>;
  /**
   * Rendering MECHANISM. Defaults to `"frame"` — the sandboxed React cell every
   * agent/package door writes.
   *
   * An EXPLICIT parameter rather than a hardcode because the Cell Studio door
   * (tRPC `widgetDefinitions.upsert`, which now delegates here) legitimately
   * writes `"iframe"` HTML widgets and `"builtin"` rows too. That difference was
   * REAL intent when the two doors were separate; collapsing it to one value
   * would have been the wrong consolidation.
   *
   * `"native"` is absent BY CONSTRUCTION: native bundles executed un-sandboxed
   * in the host origin. Both zod doors already reject it with
   * NATIVE_RENDERER_REJECTED; leaving it out of this union means no delegating
   * door can smuggle it past them. DO-NOT-REVIVE-AS-IS.
   *
   * Same omit-is-silence rule as `viewTypes`: undefined on an upsert of an
   * EXISTING row leaves the stored mechanism untouched.
   */
  rendererType?: "builtin" | "iframe" | "frame";
  /**
   * Grouping label ("core" | "data" | "ai" | "app-specific" | …). Defaults to
   * `"installed"` — what this door hardcoded while it served only the
   * agent-define and package-install paths.
   *
   * Explicit for the same reason as `rendererType`: a Cell Studio cell is
   * AUTHORED, not installed, and says so with its own category. Free text in the
   * schema; purely a picker grouping, never a trust signal (that is
   * `trustLevel`, which stays `generated` on insert for every caller).
   *
   * Omit-is-silence on update.
   */
  category?: string | null;
  /** Lucide icon name for the picker. Omit-is-silence on update. */
  icon?: string | null;
  /** JSONSchema driving the settings form. Omit-is-silence on update. */
  configSchema?: Record<string, unknown>;
  /** Default block config. Omit-is-silence on update. */
  defaultConfig?: Record<string, unknown>;
  /** Minimum grid footprint. Omit-is-silence on update. */
  minSize?: { w: number; h: number };
  /**
   * View-type affinity for using this cell as a VIEW RENDERER, e.g.
   * `["list", "table"]`. Persisted to `widget_definitions.view_renderer_view_types`
   * (migration 0221) and copied onto the browser registration's
   * `viewRenderer.viewTypes` — without it, the render chokepoint and the
   * "Rendering style" picker can never select the cell for a view.
   *
   * OMITTED (undefined) on an upsert of an EXISTING row leaves the stored
   * affinity untouched, so callers that don't know about it (older doors,
   * source-only re-pushes) can't silently erase a declared affinity. Pass an
   * explicit `[]` or `null` to clear it.
   */
  viewTypes?: string[] | null;
  /**
   * WHAT this cell renders — the de-conflated taxonomy that decides which
   * profile-renderer slots it can fill (`renderersForType` in the browser's
   * cell registry). OMITTED ⇒ the column default `widget`, which is placeable
   * but is NEVER offered as an entity-detail / entity-profile / collection
   * renderer. Same omit-is-silence rule as `viewTypes`: undefined on an upsert
   * of an EXISTING row leaves the stored kind untouched.
   */
  contentKind?: ContentKind;
  /**
   * Origins this cell's sandboxed frame may reach, e.g.
   * `["https://api.vendor.com"]`. Persisted to
   * `widget_definitions.external_hosts` (migration 0249) and composed into the
   * per-frame CSP by `buildFrameCsp` — added to `connect-src` / `img-src` and
   * to nothing else. Absent / empty ⇒ the frame reaches no external origin.
   *
   * ONLY the package-install path passes this. The AI cell-define doors
   * (`POST /cells/define`, `synap_create_cell`) deliberately do not accept it:
   * a frame's egress is a grant a human approves at install, not one an agent
   * writes for itself.
   *
   * Same omit-is-silence rule as `viewTypes` / `contentKind` / `version`:
   * undefined on an upsert of an EXISTING row leaves the stored list untouched,
   * so a source-only re-push cannot erase a declared grant. Pass an explicit
   * `[]` or `null` to clear it.
   *
   * CHANGING it on an existing row DEMOTES `trustLevel` back to `generated` —
   * see `defineCell`. Origins are NOT validated here: `buildFrameCsp` is the
   * single parser of the string before it reaches a CSP directive, and adding a
   * second one is exactly the shape of CVE-2022-41042.
   */
  externalHosts?: string[] | null;
  /**
   * PACKAGE VERSION this cell was installed at — the source-link half cells
   * were missing (B3). `widget_definitions.version` is a REAL column that has
   * always existed and that every writer left at its column default `'1.0.0'`,
   * so an installed cell reported a version it had never earned.
   *
   * Same omit-is-silence rule as `viewTypes` / `contentKind`: undefined on an
   * upsert of an EXISTING row leaves the stored version untouched, so a door
   * that knows nothing about package versions (the AI cell generator, a
   * source-only re-push) can never erase a stamped one.
   */
  version?: string | null;
  /** Acting user — stamped on the realtime event. */
  userId: string;
}

/** Normalize a declared string list: trimmed non-empty entries, deduped; `[]` → null. */
function normalizeStringList(
  raw: string[] | null | undefined
): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  // Trim BEFORE deduping. Deduping first compares the raw strings, so
  // `[" table", "table"]` survives as two distinct entries and only becomes
  // `["table","table"]` after the map — the opposite of what the doc promises.
  const cleaned = [
    ...new Set(
      raw
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    ),
  ];
  return cleaned.length > 0 ? cleaned : null;
}

export async function defineCell(
  input: DefineCellInput
): Promise<{ typeKey: string; changeType: "created" | "updated" }> {
  const depsError = validateDeps(input.deps);
  if (depsError) {
    throw new Error(`defineCell: ${depsError}`);
  }
  const db = await getDb();
  const workspaceId = input.workspaceId ?? null;

  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const typeKey = input.typeKey ?? `generated:${slug}`;

  const viewTypes = normalizeStringList(input.viewTypes);
  const externalHosts = normalizeStringList(input.externalHosts);
  // Only carried into the UPDATE branch when the caller actually spoke about
  // affinity — see `DefineCellInput.viewTypes`.
  const viewTypesUpdate =
    viewTypes === undefined ? {} : { viewRendererViewTypes: viewTypes };
  // Same omit-is-silence rule as `viewTypesUpdate` — see `DefineCellInput.contentKind`.
  const contentKindUpdate =
    input.contentKind === undefined ? {} : { contentKind: input.contentKind };
  // Same omit-is-silence rule — see `DefineCellInput.version`.
  const versionUpdate =
    input.version === undefined ? {} : { version: input.version };

  // The fields that used to be HARDCODED here and were the reason a second
  // write door existed. Each is now an explicit parameter carrying its own
  // omit-is-silence rule, so the doors' genuinely-different INTENT survives the
  // consolidation instead of being flattened into one wrong value.
  const presentationUpdate = {
    ...(input.rendererType === undefined
      ? {}
      : { rendererType: input.rendererType }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.icon === undefined ? {} : { icon: input.icon }),
    ...(input.configSchema === undefined
      ? {}
      : { configSchema: input.configSchema }),
    ...(input.defaultConfig === undefined
      ? {}
      : { defaultConfig: input.defaultConfig }),
    // `defaultSize` is DELIBERATELY absent from the update set — it always was.
    // It is user-resizable state once a cell is placed, so a source-only
    // re-push (package re-install, agent re-define) must not snap a resized
    // cell back to the author's default. Insert-only, unchanged.
    ...(input.minSize === undefined ? {} : { minSize: input.minSize }),
  };

  // Egress is the one field here that is a SECURITY GRANT, so changing it on an
  // already-approved row must cost that approval — the same rule skills already
  // live under (`allowedHostsChanged`). `trust_level = 'trusted'` is what lets a
  // frame cell's mutations skip the propose gate (`resolveViewTrust`), so a
  // republish that re-points an approved cell at a new origin while KEEPING its
  // trust would be the ungated edit that rule exists to close.
  //
  // Reuses `execFieldsChanged` — the parameterised comparator that door was
  // carved out of ("each door keeps its own list next to its own entity and
  // calls this"). Value, not presence, and canonical JSON: a re-push of an
  // UNCHANGED list must not demote, which is the regression the presence test
  // caused on the skills door.
  let externalHostsUpdate:
    { externalHosts: string[] | null } | Record<string, never> = {};
  let trustDemotion: { trustLevel: "generated" } | Record<string, never> = {};
  if (externalHosts !== undefined) {
    externalHostsUpdate = { externalHosts };
    const [existing] = await db
      .select({ externalHosts: widgetDefinitions.externalHosts })
      .from(widgetDefinitions)
      .where(
        and(
          eq(widgetDefinitions.typeKey, typeKey),
          workspaceId
            ? eq(widgetDefinitions.workspaceId, workspaceId)
            : isNull(widgetDefinitions.workspaceId)
        )
      )
      .limit(1);
    if (
      existing &&
      execFieldsChanged(
        ["externalHosts"],
        { externalHosts },
        { externalHosts: existing.externalHosts ?? null }
      )
    ) {
      trustDemotion = { trustLevel: "generated" as const };
    }
  }

  const values = {
    typeKey,
    workspaceId,
    name: input.name,
    description: input.description ?? null,
    // INSERT defaults preserve exactly what this door hardcoded before it
    // became the only door — see `DefineCellInput.category` / `.rendererType`.
    category: input.category ?? "installed",
    rendererType: input.rendererType ?? "frame",
    icon: input.icon ?? null,
    rendererSource: input.rendererSource,
    deps: (input.deps ?? {}) as Record<string, string>,
    configSchema: input.configSchema ?? {},
    defaultConfig: input.defaultConfig ?? {},
    defaultSize: input.defaultSize ?? { w: 6, h: 4 },
    ...(input.minSize === undefined ? {} : { minSize: input.minSize }),
    isActive: true,
    trustLevel: "generated" as const,
    viewRendererViewTypes: viewTypes ?? null,
    // INSERT branch: omitted ⇒ NULL ⇒ the frame reaches no external origin.
    externalHosts: externalHosts ?? null,
    // INSERT branch: omitted ⇒ let the column default (`widget`) apply.
    ...(input.contentKind === undefined
      ? {}
      : { contentKind: input.contentKind }),
    // INSERT branch: omitted ⇒ let the column default ('1.0.0') apply.
    ...versionUpdate,
  };

  let changeType: "created" | "updated" = "created";

  if (workspaceId) {
    // Workspace-scoped: unique constraint on (typeKey, workspaceId) works normally.
    const result = await db
      .insert(widgetDefinitions)
      .values(values)
      .onConflictDoUpdate({
        target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
        set: {
          name: input.name,
          description: input.description ?? null,
          rendererSource: input.rendererSource,
          deps: (input.deps ?? {}) as Record<string, string>,
          isActive: true,
          ...presentationUpdate,
          ...viewTypesUpdate,
          ...contentKindUpdate,
          ...versionUpdate,
          ...externalHostsUpdate,
          ...trustDemotion,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: widgetDefinitions.id,
        updatedAt: widgetDefinitions.updatedAt,
        createdAt: widgetDefinitions.createdAt,
      });
    const row = result[0];
    if (
      row &&
      row.updatedAt &&
      row.createdAt &&
      row.updatedAt.getTime() !== row.createdAt.getTime()
    ) {
      changeType = "updated";
    }
  } else {
    // Pod-global (workspaceId IS NULL): PostgreSQL treats NULLs as distinct in
    // unique indexes, so onConflictDoUpdate won't fire. Manual upsert.
    const updated = await db
      .update(widgetDefinitions)
      .set({
        name: input.name,
        description: input.description ?? null,
        rendererSource: input.rendererSource,
        deps: (input.deps ?? {}) as Record<string, string>,
        isActive: true,
        ...presentationUpdate,
        ...viewTypesUpdate,
        ...contentKindUpdate,
        ...versionUpdate,
        ...externalHostsUpdate,
        ...trustDemotion,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(widgetDefinitions.typeKey, typeKey),
          isNull(widgetDefinitions.workspaceId)
        )
      )
      .returning({ id: widgetDefinitions.id });
    if (updated.length === 0) {
      await db.insert(widgetDefinitions).values(values);
    } else {
      changeType = "updated";
    }
  }

  emitHubRealtimeEvent({
    eventType:
      changeType === "created"
        ? "widget_definition.create.completed"
        : "widget_definition.update.completed",
    subjectId: typeKey,
    userId: input.userId,
    data: {
      id: typeKey,
      typeKey,
      workspaceId: workspaceId ?? undefined,
      changeType,
    },
  });

  return { typeKey, changeType };
}
