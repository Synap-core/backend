/**
 * The `storybook`/`ui` sync kind: an app's Storybook mirrored into
 * `ui-component`, `ui-page` and `user-flow` records through connection sync
 * (plan 48854969 §9, W2). A handler + a pure mapper (`map-storybook-to-graph.ts`),
 * never a second runner: first run = ONE import proposal, then upserts under the
 * connection's earned `auto` rule.
 *
 * THE SOURCE is handed over per run, not polled: `storybook.sync` stores what to
 * read on the kind state (`input`: a pod file holding a bundle, or a public
 * Storybook URL) and runs the sync. A Storybook is not a broker account
 * (`brokered: false`: failures stay on the pod) and is not ticked
 * (`scheduled: false`).
 *
 * THE READ is whole or nothing. A bundle that does not parse, or one with more
 * records than the kind's `itemLimit`, FAILS the run: what a run does not read
 * is marked gone, so a partial read would retire real components.
 *
 * GONE: on a steady run the read adds a tombstone for every record this
 * connection mirrored that the bundle no longer holds; `refreshExisting` moves
 * a ui-component or ui-page to `gone` (kept, never deleted). A user-flow has no
 * `gone` option (its lifecycle is a person's): it keeps its status.
 *
 * REFRESH of an existing record writes the code facts the sync owns when they
 * changed, sets `review-state` from `source-hash` vs `reviewed-hash`, and moves
 * the status to what the inventory verdict says (phase 1: the inventory file is
 * the source of verdicts, decision D2), or back from `gone` when the record
 * returns. `deprecated` is a person's call and is never moved by the sync.
 */
import {
  and,
  db,
  drizzleSql,
  entities,
  entityExternalLinks,
  eq,
  isNull,
  profiles,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { storage } from "@synap/storage";
import {
  STORYBOOK_PROVIDER,
  STORYBOOK_SYNC_VERB,
  bundleFromStorybook,
  describeProblems,
  parseStorybookBundle,
  type StorybookBundle,
  type StorybookProblem,
} from "@synap-core/types/storybook";
import { isUuid } from "@synap-core/types/property-render";
import { readAllowedJson } from "../capabilities/http-get-json.js";
import { moveStatus } from "../lifecycle/move-status.js";
import {
  APP_EXTERNAL_ID_PREFIX,
  APP_PROFILE,
  STORYBOOK_SYNC_KIND,
  UI_COMPONENT_PROFILE,
  UI_PAGE_PROFILE,
  UI_STATUS_PROPERTY,
  USER_FLOW_PROFILE,
  isAppStandIn,
  isGone,
  mapStorybookItems,
  type StorybookRunContext,
  type StorybookSyncItem,
} from "./map-storybook-to-graph.js";
import type { SyncGraphEntity } from "./sync-graph.js";
import {
  SyncReadError,
  registerSyncKind,
  type SyncFetchRequest,
  type SyncKindContext,
} from "./sync-kind-registry.js";
import { readKindState } from "./sync-state-store.js";
import { readableEntityOfKind } from "./storybook-refs.js";

const logger = createLogger({ module: "storybook-sync" });

/** A Storybook's `index.json` / components manifest may be this large (the founder's manifest is ~1.8 MB). */
export const STORYBOOK_FETCH_MAX_BYTES = 16 * 1024 * 1024;

/** What `storybook.sync` stores on the kind state for the read. */
export interface StorybookSyncInput {
  bundleFileId?: string;
  url?: string;
  appId?: string;
  brandIdentityId?: string;
}

export function readStorybookInput(
  value: unknown
): StorybookSyncInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const input: StorybookSyncInput = {
    ...(str("bundleFileId") ? { bundleFileId: str("bundleFileId") } : {}),
    ...(str("url") ? { url: str("url") } : {}),
    ...(str("appId") ? { appId: str("appId") } : {}),
    ...(str("brandIdentityId") ? { brandIdentityId: str("brandIdentityId") } : {}),
  };
  return input.bundleFileId || input.url ? input : null;
}

/** The source's account hint: what the registry row names. */
export function storybookAccountHint(
  input: { url?: string },
  bundle: Pick<StorybookBundle, "source"> | null
): string {
  // The validator holds a bundle to name its repo or its url.
  const named = input.url ?? bundle?.source.repo ?? bundle?.source.url ?? "";
  return `${STORYBOOK_PROVIDER}:${named.replace(/\/+$/, "")}`;
}

const fail = (
  message: string,
  errorClass: "validation" | "target_missing" | "permission" | "provider"
) => new SyncReadError(message, STORYBOOK_SYNC_VERB, { errorClass });

function problemsError(what: string, problems: StorybookProblem[]): SyncReadError {
  const errors = problems.filter((p) => p.severity === "error");
  const shown = errors.slice(0, 10);
  const more = errors.length > shown.length ? ` (and ${errors.length - shown.length} more)` : "";
  return fail(`${what} cannot be mirrored: ${describeProblems(shown)}${more}`, "validation");
}

/** A pod file's bytes, through the file read floor, as JSON. */
async function readBundleFile(owner: string, fileId: string): Promise<unknown> {
  const { readableFileEntity } = await import("../../routers/file-upload.js");
  const readable = await readableFileEntity(owner, fileId);
  if (!readable.ok) {
    throw fail(
      `The storybook bundle (file ${fileId}) cannot be read: ${readable.error}`,
      readable.status === 404 ? "target_missing" : "permission"
    );
  }
  if (!readable.entity.storageKey) {
    throw fail(`The storybook bundle (file ${fileId}) has no stored bytes.`, "target_missing");
  }
  const bytes = await storage.downloadBuffer(readable.entity.storageKey);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw fail(`The storybook bundle (file ${fileId}) is not JSON.`, "validation");
  }
}

/**
 * A public Storybook's own files. `index.json` must read; the components
 * manifest is optional (an older or unconfigured Storybook serves none): a
 * 403/404/410 on it means "not served", any other failure fails the read.
 */
async function readPublicStorybook(baseUrl: string): Promise<{
  index: unknown;
  manifest: unknown;
}> {
  const base = baseUrl.replace(/\/+$/, "");
  const index = await readAllowedJson(
    { url: `${base}/index.json` },
    { maxBytes: STORYBOOK_FETCH_MAX_BYTES }
  );
  if (index.status !== "ok") {
    throw fail(
      `The Storybook at ${base} cannot be read: ${index.message}`,
      index.reason === "host_not_allowed" || index.reason === "redirect_host_not_allowed"
        ? "permission"
        : "provider"
    );
  }
  const manifest = await readAllowedJson(
    { url: `${base}/manifests/components.json` },
    { maxBytes: STORYBOOK_FETCH_MAX_BYTES }
  );
  if (manifest.status === "ok") return { index: index.json, manifest: manifest.json };
  if (manifest.reason === "expired") return { index: index.json, manifest: undefined };
  throw fail(
    `The Storybook at ${base} serves a components manifest that cannot be read: ${manifest.message}`,
    "provider"
  );
}

/** The bundle a run mirrors, from what `storybook.sync` stored. Throws, never an empty bundle. */
export async function loadStorybookBundle(
  owner: string,
  input: StorybookSyncInput
): Promise<StorybookBundle> {
  if (input.bundleFileId) {
    const raw = await readBundleFile(owner, input.bundleFileId);
    const read = parseStorybookBundle(raw);
    if (!read.ok) throw problemsError(`The storybook bundle (file ${input.bundleFileId})`, read.problems);
    return read.value;
  }
  const url = input.url!;
  const { index, manifest } = await readPublicStorybook(url);
  const read = bundleFromStorybook({
    index,
    manifest,
    source: { url: url.replace(/\/+$/, "") },
    generatedAt: new Date().toISOString(),
  });
  if (!read.ok) throw problemsError(`The Storybook at ${url}`, read.problems);
  return read.value;
}

/** Every key a bundle holds: the external ids it mirrors. */
export function bundleKeys(bundle: StorybookBundle): Set<string> {
  return new Set([
    ...bundle.components.map((c) => c.key),
    ...bundle.pages.map((p) => p.key),
    ...bundle.flows.map((f) => f.key),
  ]);
}

/** The run's items: every record, in bundle order (components first, so pages and flows find them). */
export function bundleItems(
  bundle: StorybookBundle,
  input: StorybookSyncInput
): StorybookSyncItem[] {
  const run: StorybookRunContext = {
    appId: input.appId ?? null,
    storybookUrl: bundle.source.url ?? null,
  };
  return [
    ...bundle.components.map((record) => ({ type: "component" as const, record, run })),
    ...bundle.pages.map((record) => ({ type: "page" as const, record, run })),
    ...bundle.flows.map((record) => ({ type: "flow" as const, record, run })),
  ];
}

/**
 * Tombstones: the ui-components and ui-pages this connection mirrored that
 * the bundle no longer holds and that are not gone yet.
 */
async function goneItems(
  connectionId: string,
  keys: Set<string>
): Promise<StorybookSyncItem[]> {
  const rows = await db
    .select({
      externalId: entityExternalLinks.externalId,
      title: entities.title,
      status: entities.status,
      profileSlug: profiles.slug,
    })
    .from(entityExternalLinks)
    .innerJoin(entities, eq(entities.id, entityExternalLinks.entityId))
    .innerJoin(profiles, eq(profiles.id, entities.profileId))
    .where(
      and(
        eq(entityExternalLinks.provider, STORYBOOK_PROVIDER),
        eq(entityExternalLinks.nangoConnectionId, connectionId),
        eq(entityExternalLinks.status, "active"),
        isNull(entities.deletedAt)
      )
    );
  return goneFromRows(rows, keys);
}

/** Pure half of {@link goneItems}: which mirrored rows the bundle stopped emitting. */
export function goneFromRows(
  rows: Array<{ externalId: string; title: string | null; status: string | null; profileSlug: string }>,
  keys: Set<string>
): StorybookSyncItem[] {
  const out: StorybookSyncItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (keys.has(r.externalId) || seen.has(r.externalId)) continue;
    if (r.externalId.startsWith(APP_EXTERNAL_ID_PREFIX)) continue;
    if (r.profileSlug !== UI_COMPONENT_PROFILE && r.profileSlug !== UI_PAGE_PROFILE) continue;
    if (r.status === "gone") continue;
    seen.add(r.externalId);
    out.push({
      type: "gone",
      externalId: r.externalId,
      profileSlug: r.profileSlug,
      title: r.title ?? r.externalId,
    });
  }
  return out;
}

async function fetchStorybookPage(ctx: SyncKindContext, req: SyncFetchRequest) {
  const state = readKindState(ctx.toolMetadata, ctx.kind, ctx.connectionId);
  const input = readStorybookInput(state.input);
  if (!input) {
    throw fail(
      "No Storybook to read: run storybook.sync with a bundleFileId or a url.",
      "validation"
    );
  }
  const bundle = await loadStorybookBundle(ctx.owner, input);
  const items = bundleItems(bundle, input);
  if (items.length > req.pageSize) {
    throw fail(
      `The bundle holds ${items.length} records, more than this sync reads in one run (${req.pageSize}); raise the ui kind's itemLimit. Nothing was mirrored: a partial read would mark the rest gone.`,
      "validation"
    );
  }
  const gone = req.mode === "steady" ? await goneItems(ctx.connectionId, bundleKeys(bundle)) : [];
  return { items: [...items, ...gone], nextPageToken: null };
}

/** The code facts the sync owns on each kind: written on refresh when they changed. */
export const SYNC_OWNED_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  [UI_COMPONENT_PROFILE]: [
    "source-path",
    "export-name",
    "story-ids",
    "story-url",
    "screenshot",
    "props-summary",
    "component-family",
    "component-level",
    "source-hash",
    "design-app",
  ],
  [UI_PAGE_PROFILE]: [
    "surface",
    "page-template",
    "page-layout",
    "route",
    "story-id",
    "story-url",
    "screenshot",
    "source-hash",
    "design-app",
  ],
  [USER_FLOW_PROFILE]: [
    "need",
    "entry",
    "done-when",
    "surface",
    "flow-source-id",
    "steps",
    "design-app",
  ],
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Pure: what a refresh writes on an existing record. `patch` = owned facts that
 * changed (a fact the bundle no longer carries keeps its last value) and the
 * review state; `moveTo` = the status to move to, or null.
 */
export function planRefresh(
  incoming: SyncGraphEntity,
  current: { properties: Record<string, unknown>; status: string | null }
): { patch: Record<string, unknown>; moveTo: string | null } {
  const patch: Record<string, unknown> = {};
  const lifecycled =
    incoming.profileSlug === UI_COMPONENT_PROFILE || incoming.profileSlug === UI_PAGE_PROFILE;

  if (isGone(incoming)) {
    return { patch, moveTo: lifecycled && current.status !== "gone" ? "gone" : null };
  }
  for (const key of SYNC_OWNED_PROPERTIES[incoming.profileSlug] ?? []) {
    const next = incoming.properties[key];
    if (next === undefined) continue;
    if (!same(next, current.properties[key])) patch[key] = next;
  }

  if (incoming.profileSlug === UI_COMPONENT_PROFILE) {
    const sourceHash = incoming.properties["source-hash"];
    const reviewed = current.properties["reviewed-hash"];
    const state = current.properties["review-state"];
    if (typeof reviewed === "string" && reviewed.length > 0 && state !== "in-review") {
      const next = reviewed === sourceHash ? "fresh" : "changed";
      if (next !== state) patch["review-state"] = next;
    }
  }

  let moveTo: string | null = null;
  if (lifecycled) {
    const verdict = incoming.properties[UI_STATUS_PROPERTY];
    const wanted = typeof verdict === "string" ? verdict : null;
    if (current.status === "gone") moveTo = wanted ?? "proposed";
    else if (wanted && current.status !== wanted && current.status !== "deprecated") moveTo = wanted;
  }
  return { patch, moveTo };
}

async function refreshStorybookRecord(
  entityId: string,
  incoming: SyncGraphEntity,
  ctx: SyncKindContext
): Promise<boolean> {
  if (isAppStandIn(incoming)) return false;
  const row = await db.query.entities.findFirst({
    where: eq(entities.id, entityId),
    columns: { properties: true, status: true },
  });
  if (!row) return false;
  const { patch, moveTo } = planRefresh(incoming, {
    properties: (row.properties ?? {}) as Record<string, unknown>,
    status: row.status ?? null,
  });
  let wrote = false;
  if (Object.keys(patch).length > 0) {
    await db
      .update(entities)
      .set({
        properties: drizzleSql`COALESCE(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, entityId));
    wrote = true;
  }
  if (moveTo) {
    const moved = await moveStatus({
      entityId,
      to: moveTo,
      actor: { kind: "system", userId: ctx.owner },
      workspaceId: ctx.workspaceId,
      reason: isGone(incoming)
        ? "The Storybook no longer has it."
        : "The Storybook sync (the inventory's verdict).",
    });
    if (moved.status === "moved" || moved.status === "proposed") wrote = true;
    else if (moved.status !== "unchanged") {
      // A refused or denied system move is a fault of this sync's model (an
      // option the kind does not declare): fail the run, never skip it quietly.
      throw new Error(
        `storybook sync: moving ${entityId} to ${moveTo} was ${moved.status}: ${"reason" in moved ? moved.reason : ""}`
      );
    }
  }
  return wrote;
}

/** The app stand-in resolves to the existing app the owner can see, never a new one. */
async function findStorybookApp(entity: SyncGraphEntity, ctx: SyncKindContext): Promise<string | null> {
  if (!isAppStandIn(entity)) return null;
  const appId = entity.identity.externalId.slice(APP_EXTERNAL_ID_PREFIX.length);
  if (!isUuid(appId)) return null;
  const found = await readableEntityOfKind(ctx.owner, appId, APP_PROFILE);
  if (!found) {
    // storybook.sync checked the app before the run; it vanished since.
    logger.warn({ appId, connectionId: ctx.connectionId }, "storybook sync: the app is gone");
    throw fail(`The app ${appId} cannot be read any more; run storybook.sync without it or with another app.`, "target_missing");
  }
  return found;
}

registerSyncKind({
  provider: STORYBOOK_PROVIDER,
  kind: STORYBOOK_SYNC_KIND,
  // windowDays is unused (a bundle is not dated); itemLimit bounds one bundle.
  defaults: { enabled: true, windowDays: 1, itemLimit: 10_000, sources: [] },
  profileSlugs: [UI_COMPONENT_PROFILE, UI_PAGE_PROFILE, USER_FLOW_PROFILE, APP_PROFILE],
  openableProfileSlugs: [UI_COMPONENT_PROFILE, UI_PAGE_PROFILE],
  brokered: false,
  scheduled: false,
  fetchPage: fetchStorybookPage,
  mapItems: (items) => mapStorybookItems(items as StorybookSyncItem[]),
  findExisting: findStorybookApp,
  refreshExisting: refreshStorybookRecord,
});
