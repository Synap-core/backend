/**
 * RENDERER-USAGE builder — "which renderers are actually bound, where, and is
 * the binding still pointing at something that exists?".
 *
 * The Surfaces plane needs a usage-health rollup per renderer KEY. There is no
 * `renderer` table: a binding is a `RendererRef` JSON blob stored in one of
 * three places, so this enumerates all three (every one a small table), extracts
 * the key from each ref, and reverse-indexes key → bindings in JS.
 *
 *   (a) workspace overlay — `workspaces.settings.profileRenderers[slug][k]`.
 *       The declared TYPE on the settings column only names `list`/`detail`
 *       (STALE — schema/workspaces.ts). The live writer keys by ContentKind
 *       (`entity-detail` / `entity-profile` / `collection`), so BOTH key spaces
 *       are iterated and the legacy slot keys are flagged `legacy: true`.
 *   (b) profile default — `profiles.default_renderers` (ContentKind-keyed) plus
 *       the 3 deprecated columns (`default_list_renderer` / `_detail_` /
 *       `_dashboard_`, migration 0112), also flagged `legacy: true`.
 *   (d) per-view — `views.config.rendererRef` AND `views.config.render.rendererRef`
 *       (both nestings are legal — see `assertValidRendererRef` in routers/views.ts).
 *
 * (c) per-ENTITY overrides (`entities.system_data.renderer`) are NOT enumerated
 * in v1 — that scan is unbounded. Only a single scoped `count(*)` is returned.
 *
 * REGISTRATION is answered from `widget_definitions` (the ONE server-side cell
 * registry), and it is answered HONESTLY: only a `{kind:"cell"}` key whose
 * conventions are server-visible can be called `"no"`. Frontend-only conventions
 * (`entity-detail-<slug>`), the layer-3 fallback sentinels, `view-adapter` keys
 * (no server registry exists for adapters) and `view:` refs are forced to
 * `"unknown"` — never "no" — so this surface can't invent red.
 *
 * Access: every store is read through ITS existing door — `userVisibleWhere`
 * for workspaces, `ProfileRepository.getAccessibleProfiles` for profiles
 * (`profiles` is intentionally NOT in the access registry), `viewVisibleWhere`
 * for views, `scopedDb` for widget_definitions. `workspaceId` NARROWS; pod-wide
 * NULL-workspace rows are always included; omitted ⇒ the pod-wide user floor.
 *
 * Per-store failures degrade to omission (that store contributes no bindings)
 * and are logged — never a 500, mirroring `listCapabilityCompositions`.
 */

import {
  db,
  getDb,
  and,
  eq,
  or,
  isNull,
  count,
  workspaces,
  views,
  entities,
  widgetDefinitions,
  ProfileRepository,
} from "@synap/database";
// The `sql` re-exported by @synap/database is postgres.js's tagged template,
// NOT drizzle's — a raw fragment inside a drizzle `where()` must use this one.
import { sql as drizzleSql } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import {
  userVisibleWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import { scopedDb } from "../../access/scoped-db.js";
import type { AccessContext } from "../../access/context.js";

const logger = createLogger({ module: "renderer-usage" });

/** Where a binding was found. `entity` (per-entity override) is deferred (v1). */
export type RendererBindingStore = "workspace" | "profile" | "view";

/** The taxonomy of a bound renderer key (derived from the RendererRef shape). */
export type RendererKeyKind = "cell" | "view-adapter" | "view" | "other";

export interface RendererBinding {
  store: RendererBindingStore;
  /** The BINDER's id — the workspace / profile / view that carries the ref. */
  id: string;
  /** The binder's display name. */
  name: string;
  /** Set for workspace-overlay + profile bindings. */
  profileSlug?: string;
  /** The ContentKind (or legacy slot key) the ref is bound under. */
  contentKind?: string;
  /** True when the ref sits under a deprecated slot key / column. */
  legacy?: boolean;
  workspaceId: string | null;
}

export interface RendererUsage {
  /** `cellKey` | `adapterKey` | `view:<uuid>` | `<refKind>:<appId>`. */
  key: string;
  kind: RendererKeyKind;
  registered: "yes" | "no" | "unknown";
  bindings: RendererBinding[];
  health: {
    status: "ok" | "degraded" | "unknown";
    bindingCount: number;
    staleCount: number;
  };
  gaps: string[];
}

export interface RendererUsageReport {
  usage: RendererUsage[];
  /**
   * How many entities carry a per-entity renderer override
   * (`system_data ? 'renderer'`), counted once over the caller's owner-safe
   * entity floor. `null` when the count could not be taken.
   */
  perEntityOverrideCount: number | null;
}

export interface RendererUsageInput {
  userId: string;
  /** NARROWS. Pod-wide NULL-workspace rows are always included. */
  workspaceId?: string | null;
  /** Filter the result to ONE renderer key (the Renderers deep-dive). */
  cellKey?: string;
  /** DEFERRED in v1 — the per-entity scan is unbounded; only the count runs. */
  includeEntityBindings?: boolean;
  /** The caller's access context (for the scopedDb widget_definitions read). */
  access: AccessContext;
}

/** The 3 ContentKind keys the live renderer writer uses. */
const CONTENT_KINDS = [
  "entity-detail",
  "entity-profile",
  "collection",
] as const;
/** The pre-0112 slot keys, still present in stored overlays. */
const LEGACY_SLOTS = ["list", "detail", "dashboard"] as const;

/**
 * Layer-3 fallback sentinels returned by
 * `ProfileResolutionService.getEffectiveRenderer` when NOTHING is bound. They
 * are resolved by frontend convention, not by `widget_definitions` — calling
 * them unregistered would paint every un-customized profile red.
 */
const LAYER3_SENTINELS = new Set([
  "list",
  "entity-detail",
  "profile-dashboard",
]);
/** The browser's per-profile convention cells — frontend-registered only. */
const FRONTEND_CONVENTION = /^entity-detail-/;

export async function buildRendererUsage(
  input: RendererUsageInput
): Promise<RendererUsageReport> {
  const { userId, cellKey } = input;
  const workspaceId = input.workspaceId ?? null;

  const [wsBindings, profileBindings, viewBindings, registry, entityCount] =
    await Promise.all([
      safe("workspace-overlay", () =>
        readWorkspaceBindings(userId, workspaceId)
      ),
      safe("profile-defaults", () => readProfileBindings(userId, workspaceId)),
      safe("view-refs", () => readViewBindings(userId, workspaceId)),
      safeNullable("widget-definitions", () =>
        readRegistry(input.access, workspaceId)
      ),
      safeNullable("entity-override-count", () =>
        countEntityOverrides(userId, workspaceId)
      ),
    ]);

  // ── Reverse-index: key → its bindings. ──────────────────────────────────
  const byKey = new Map<
    string,
    { kind: RendererKeyKind; bindings: RendererBinding[] }
  >();
  for (const found of [...wsBindings, ...profileBindings, ...viewBindings]) {
    if (cellKey && found.key !== cellKey) continue;
    const entry = byKey.get(found.key) ?? { kind: found.kind, bindings: [] };
    entry.bindings.push(found.binding);
    byKey.set(found.key, entry);
  }

  const activeKeys = registry ?? new Set<string>();
  const usage: RendererUsage[] = [];
  for (const [key, entry] of [...byKey.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const registered = resolveRegistered(
      key,
      entry.kind,
      activeKeys,
      registry !== null
    );
    const bindingCount = entry.bindings.length;
    const staleCount = registered === "no" ? bindingCount : 0;
    const gaps =
      registered === "no" ? entry.bindings.map((b) => describeGap(b, key)) : [];
    usage.push({
      key,
      kind: entry.kind,
      registered,
      bindings: entry.bindings,
      health: {
        status:
          registered === "unknown"
            ? "unknown"
            : staleCount > 0
              ? "degraded"
              : "ok",
        bindingCount,
        staleCount,
      },
      gaps,
    });
  }

  return { usage, perEntityOverrideCount: entityCount };
}

/**
 * A key is confidently UNREGISTERED only when the server owns its registry.
 * Everything else is "unknown" — see the header. When the registry read itself
 * failed (`registryLoaded === false`) NOTHING can be called "no".
 */
function resolveRegistered(
  key: string,
  kind: RendererKeyKind,
  activeKeys: Set<string>,
  registryLoaded: boolean
): "yes" | "no" | "unknown" {
  if (activeKeys.has(key)) return "yes";
  if (!registryLoaded) return "unknown";
  if (kind !== "cell") return "unknown";
  if (LAYER3_SENTINELS.has(key)) return "unknown";
  if (FRONTEND_CONVENTION.test(key)) return "unknown";
  return "no";
}

function describeGap(b: RendererBinding, key: string): string {
  const where =
    b.store === "workspace"
      ? `Workspace "${b.name}"`
      : b.store === "profile"
        ? `Profile "${b.name}"`
        : `View "${b.name}"`;
  const subject = b.profileSlug
    ? `${b.profileSlug}→${b.contentKind ?? "?"}`
    : (b.contentKind ?? "renderer");
  return `${where} binds ${subject} to unregistered cell "${key}"`;
}

// ── Ref → key ─────────────────────────────────────────────────────────────

interface FoundBinding {
  key: string;
  kind: RendererKeyKind;
  binding: RendererBinding;
}

/** Extract the reverse-index key from a stored `RendererRef`. */
export function rendererRefKey(
  ref: unknown
): { key: string; kind: RendererKeyKind } | null {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const r = ref as Record<string, unknown>;
  if (r.kind === "cell" && typeof r.cellKey === "string" && r.cellKey)
    return { key: r.cellKey, kind: "cell" };
  if (
    r.kind === "view-adapter" &&
    typeof r.adapterKey === "string" &&
    r.adapterKey
  )
    return { key: r.adapterKey, kind: "view-adapter" };
  if (r.kind === "view" && typeof r.viewId === "string" && r.viewId)
    return { key: `view:${r.viewId}`, kind: "view" };
  if (
    (r.kind === "iframe-srcdoc" || r.kind === "external-app") &&
    typeof r.appId === "string" &&
    r.appId
  )
    return { key: `${r.kind}:${r.appId}`, kind: "other" };
  return null;
}

// ── (a) workspace overlay ─────────────────────────────────────────────────

async function readWorkspaceBindings(
  userId: string,
  workspaceId: string | null
): Promise<FoundBinding[]> {
  const lens = workspaceId ? eq(workspaces.id, workspaceId) : undefined;
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(and(lens, userVisibleWhere(workspaces.id, userId)));

  const out: FoundBinding[] = [];
  for (const row of rows) {
    // The declared type only names list/detail — read it structurally instead.
    const overlay = (row.settings as { profileRenderers?: unknown } | null)
      ?.profileRenderers;
    if (!overlay || typeof overlay !== "object") continue;
    for (const [slug, slots] of Object.entries(
      overlay as Record<string, unknown>
    )) {
      if (!slots || typeof slots !== "object") continue;
      const slotMap = slots as Record<string, unknown>;
      for (const slotKey of [...CONTENT_KINDS, ...LEGACY_SLOTS]) {
        const found = rendererRefKey(slotMap[slotKey]);
        if (!found) continue;
        out.push({
          ...found,
          binding: {
            store: "workspace",
            id: row.id,
            name: row.name,
            profileSlug: slug,
            contentKind: slotKey,
            ...((LEGACY_SLOTS as readonly string[]).includes(slotKey)
              ? { legacy: true }
              : {}),
            workspaceId: row.id,
          },
        });
      }
    }
  }
  return out;
}

// ── (b) profile defaults ──────────────────────────────────────────────────

/** deprecated column → the ContentKind it was replaced by (migration 0112). */
const LEGACY_COLUMNS = [
  ["defaultListRenderer", "collection"],
  ["defaultDetailRenderer", "entity-detail"],
  ["defaultDashboardRenderer", "entity-profile"],
] as const;

async function readProfileBindings(
  userId: string,
  workspaceId: string | null
): Promise<FoundBinding[]> {
  const repo = new ProfileRepository(await getDb());
  // getAccessibleProfiles takes "" for the workspace-less (pod) altitude — that
  // branch broadens to the caller's member-workspace floor, which is exactly
  // the pod-wide read we want when no lens is given.
  const profiles = await repo.getAccessibleProfiles(userId, workspaceId ?? "");

  const out: FoundBinding[] = [];
  for (const p of profiles) {
    const row = p as unknown as Record<string, unknown>;
    const name = String(row.displayName ?? row.slug ?? p.id);
    const wsId = (row.workspaceId as string | null | undefined) ?? null;
    const defaults = row.defaultRenderers;
    if (defaults && typeof defaults === "object") {
      for (const [contentKind, ref] of Object.entries(
        defaults as Record<string, unknown>
      )) {
        const found = rendererRefKey(ref);
        if (!found) continue;
        out.push({
          ...found,
          binding: {
            store: "profile",
            id: p.id,
            name,
            profileSlug: String(row.slug ?? ""),
            contentKind,
            workspaceId: wsId,
          },
        });
      }
    }
    for (const [column, contentKind] of LEGACY_COLUMNS) {
      const found = rendererRefKey(row[column]);
      if (!found) continue;
      out.push({
        ...found,
        binding: {
          store: "profile",
          id: p.id,
          name,
          profileSlug: String(row.slug ?? ""),
          contentKind,
          legacy: true,
          workspaceId: wsId,
        },
      });
    }
  }
  return out;
}

// ── (d) per-view refs ─────────────────────────────────────────────────────

async function readViewBindings(
  userId: string,
  workspaceId: string | null
): Promise<FoundBinding[]> {
  const lens = workspaceId
    ? or(isNull(views.workspaceId), eq(views.workspaceId, workspaceId))
    : undefined;
  const rows = await db
    .select({
      id: views.id,
      name: views.name,
      type: views.type,
      workspaceId: views.workspaceId,
      config: views.config,
    })
    .from(views)
    .where(
      and(
        lens,
        ownerPrivateVisibleWhere(views.workspaceId, views.userId, userId)
      )
    );

  const out: FoundBinding[] = [];
  for (const row of rows) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const nested = config.render;
    const candidates: unknown[] = [config.rendererRef];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      candidates.push((nested as Record<string, unknown>).rendererRef);
    }
    for (const candidate of candidates) {
      const found = rendererRefKey(candidate);
      if (!found) continue;
      out.push({
        ...found,
        binding: {
          store: "view",
          id: row.id,
          name: row.name,
          contentKind: row.type,
          workspaceId: row.workspaceId ?? null,
        },
      });
    }
  }
  return out;
}

// ── The registry (widget_definitions) ─────────────────────────────────────

/** The set of ACTIVE `typeKey`s visible at this altitude, or `null` on failure. */
async function readRegistry(
  access: AccessContext,
  workspaceId: string | null
): Promise<Set<string>> {
  const scoped = scopedDb(access.withLens(workspaceId ?? undefined));
  const rows = await scoped.findMany<{
    typeKey: string;
    isActive: boolean;
    workspaceId: string | null;
  }>(widgetDefinitions, {
    columns: { typeKey: true, isActive: true, workspaceId: true },
  });
  const out = new Set<string>();
  for (const r of rows) if (r.isActive) out.add(r.typeKey);
  return out;
}

// ── (c) per-entity override COUNT only ────────────────────────────────────

/**
 * `count(*)` of entities carrying a per-entity renderer override. Scoped with
 * `ownerPrivateVisibleWhere` — plain `userVisibleWhere` is owner-BLIND on the
 * NULL-workspace branch and would count another user's private entities.
 */
async function countEntityOverrides(
  userId: string,
  workspaceId: string | null
): Promise<number> {
  const lens = workspaceId
    ? or(isNull(entities.workspaceId), eq(entities.workspaceId, workspaceId))
    : undefined;
  const rows = await db
    .select({ value: count() })
    .from(entities)
    .where(
      and(
        lens,
        ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, userId),
        drizzleSql`${entities.systemData} ? 'renderer'`
      )
    );
  return Number(rows[0]?.value ?? 0);
}

// ── Per-store isolation ───────────────────────────────────────────────────

async function safe<T>(store: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(
      { store, err },
      "buildRendererUsage: store degraded to omission"
    );
    return [];
  }
}

async function safeNullable<T>(
  store: string,
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ store, err }, "buildRendererUsage: store degraded to null");
    return null;
  }
}
