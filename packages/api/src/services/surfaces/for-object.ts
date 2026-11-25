/**
 * surfacesForObject — the ONE find door for surfaces (Surfaces wave P1, plan
 * 187bbb25 §0 and P1): "which UI does this object already carry?".
 *
 * Every door calls this: tRPC `surfaces.forObject`, MCP `synap_find_surfaces`,
 * Hub REST `GET /api/hub/surfaces` (and through it hub-rest-client
 * `listSurfaces`). The answer is the UNION of every store that anchors UI to
 * an object today, each read under ITS OWN visibility floor:
 *
 *   attaches        `links <anchor> --attaches--> view|document|cell_instance`
 *                   (the `attached` relation, Surfaces P3,
 *                   `services/surfaces/attach.ts`), every anchor kind, each
 *                   surface under its own table's floor.
 *   renders         `readBoundRenderer` (the one ladder,
 *                   `getEffectiveRendererWithSource` over `renderer_bindings`
 *                   then the legacy stores) for the anchor's kind, per slot.
 *                   An entity's own look is no longer a renderer: its old
 *                   override (`entities.system_data.renderer`) is an
 *                   attachment (conversion `p3.surfaces.*`, and
 *                   `entities.setEntityRenderer` writes one).
 *   views           `scopedDb` on `views` (the VISIBLE floor,
 *                   `viewReadableWhere`, never owner-only): project pins and
 *                   exposures, a kind's views (`scope_profile_ids`,
 *                   `config.profileSlug`), a space's home boards
 *                   (`metadata.homeScope`, `metadata.scopedSurface`), a
 *                   session's board (`metadata.sessionId`), an entity's bento
 *                   (`entities.system_data.bentoViewId`).
 *   profile-bento   `workspaces.settings.profileBentoViewIds[slug]`.
 *   entity-body     the entity's one document (`entities.document_id`).
 *   session-outputs the `artifacts` ledger of a session.
 *   cell-relations  cell instances linked `cell --references--> entity`
 *                   (`relations`, the tRPC `cellInstances.link` writer).
 *   start-page      a space's `settings.layout.primarySurface`.
 *   sites           a project's Site (`resource_shares`, public, 0336).
 *
 * The legacy anchors the P3 conversions moved onto `attaches` (an entity's
 * bento, a cell linked to an entity) are still read, because their old
 * writers still write them; `dedupe` names each surface once, the
 * attachment first.
 *
 * A store that throws lands in `unavailable` with its error: an empty `rows`
 * means "nothing there", never "could not look" (Critical Rule). The anchor
 * itself is loaded first under its own floor: an object the caller cannot see
 * (or that does not exist) is a NOT_FOUND, never an empty list.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  getDb,
  and,
  eq,
  or,
  isNull,
  inArray,
  ProfileRepository,
} from "@synap/database";
import {
  artifacts,
  cellInstances,
  documents,
  entities,
  focusSessions,
  playbooks,
  projectTracks,
  projects,
  relations,
  resourceShares,
  views,
  workspaces,
} from "@synap/database/schema";
// The `sql` re-exported by @synap/database is postgres.js's tagged template,
// NOT drizzle's — a raw fragment inside a drizzle `where()` must use this one.
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type {
  AnchorKind,
  SurfaceAnchor,
  SurfaceBody,
  SurfaceRelation,
  SurfaceRow,
  SurfacesForObject,
} from "@synap-core/types/surfaces";
import { scopedDb } from "../../access/scoped-db.js";
import type { AccessContext } from "../../access/context.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { openLink } from "../../utils/deep-links.js";
import { readBoundRenderer } from "../renderers/renderer-target-checks.js";
import { RENDERER_TARGETS } from "../renderers/renderer-targets.js";
import { readAttachedSurfaces } from "./attach.js";

export interface SurfacesForObjectContext {
  userId: string;
  access: AccessContext;
}

export interface SurfacesForObjectInput {
  kind: AnchorKind;
  id: string;
  /** NARROWS the space-scoped stores; omitted = everything the caller sees. */
  workspaceId?: string | null;
}

/** What the anchor read yields for the sources that need it. */
interface LoadedAnchor {
  anchor: SurfaceAnchor;
  /** The lens the renderer ladder resolves in. */
  workspaceId: string | null;
  /** entity: its kind's slug; profile: the kind's slug. */
  profileSlug?: string;
  /** profile: the profile row id (views scope by id). */
  profileId?: string;
  entity?: {
    documentId: string | null;
    systemData: Record<string, unknown>;
  };
  workspaceSettings?: Record<string, unknown>;
}

interface Source {
  source: string;
  read: () => Promise<SurfaceRow[]>;
}

export async function surfacesForObject(
  ctx: SurfacesForObjectContext,
  input: SurfacesForObjectInput
): Promise<SurfacesForObject> {
  const workspaceId = input.workspaceId ?? null;
  const access = workspaceId ? ctx.access.withLens(workspaceId) : ctx.access;
  const loaded = await loadAnchor(ctx, access, input);
  const sources = sourcesFor(ctx, access, loaded, workspaceId);

  const settled = await Promise.allSettled(sources.map((s) => s.read()));
  const rows: SurfaceRow[] = [];
  const unavailable: SurfacesForObject["unavailable"] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") rows.push(...result.value);
    else
      unavailable.push({
        source: sources[i]!.source,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
  });
  return { rows: dedupe(rows), unavailable };
}

/** One row per (relation, body id): two stores naming one surface say it once. */
function dedupe(rows: SurfaceRow[]): SurfaceRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.relation}:${r.body}:${r.id}:${r.slot ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── The anchor ────────────────────────────────────────────────────────────

const notFound = (anchor: SurfaceAnchor): TRPCError =>
  new TRPCError({
    code: "NOT_FOUND",
    message: `No ${anchor.kind} ${anchor.id} that you can see.`,
  });

async function loadAnchor(
  ctx: SurfacesForObjectContext,
  access: AccessContext,
  input: SurfacesForObjectInput
): Promise<LoadedAnchor> {
  const anchor: SurfaceAnchor = { kind: input.kind, id: input.id };
  const scoped = scopedDb(access);
  const byId = <T extends { id: unknown }>(table: T) =>
    eq(table.id as never, input.id);

  switch (input.kind) {
    case "entity": {
      const row = await scoped.findFirst<{
        id: string;
        workspaceId: string | null;
        type: string;
        documentId: string | null;
        systemData: Record<string, unknown> | null;
      }>(entities, {
        where: byId(entities),
        columns: {
          id: true,
          workspaceId: true,
          type: true,
          documentId: true,
          systemData: true,
        },
      });
      if (!row) throw notFound(anchor);
      return {
        anchor,
        workspaceId: input.workspaceId ?? row.workspaceId,
        profileSlug: row.type,
        entity: {
          documentId: row.documentId,
          systemData: row.systemData ?? {},
        },
      };
    }
    case "profile": {
      // `profiles` has no VisibilityRule by design: the repository's
      // accessible-profiles read is its floor (as in renderer-usage). The
      // anchor id may be the profile's id or its slug.
      const repo = new ProfileRepository(await getDb());
      const visible = await repo.getAccessibleProfiles(
        ctx.userId,
        input.workspaceId ?? ""
      );
      const profile = visible.find(
        (p) =>
          p.id === input.id ||
          (p as unknown as { slug?: string }).slug === input.id
      ) as unknown as
        { id: string; slug: string; workspaceId?: string | null } | undefined;
      if (!profile) throw notFound(anchor);
      return {
        anchor,
        workspaceId: input.workspaceId ?? profile.workspaceId ?? null,
        profileSlug: profile.slug,
        profileId: profile.id,
      };
    }
    case "workspace": {
      const [row] = await db
        .select({ id: workspaces.id, settings: workspaces.settings })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, input.id),
            userVisibleWhere(workspaces.id, ctx.userId)
          )
        )
        .limit(1);
      if (!row) throw notFound(anchor);
      return {
        anchor,
        workspaceId: row.id,
        workspaceSettings: (row.settings ?? {}) as Record<string, unknown>,
      };
    }
    case "project":
    case "track":
    case "playbook":
    case "session": {
      const table = {
        project: projects,
        track: projectTracks,
        playbook: playbooks,
        session: focusSessions,
      }[input.kind];
      const row = await scoped.findFirst<{ id: string }>(table, {
        where: byId(table),
        columns: { id: true },
      });
      if (!row) throw notFound(anchor);
      return { anchor, workspaceId: input.workspaceId ?? null };
    }
  }
}

// ── The sources each anchor kind reads ────────────────────────────────────

function sourcesFor(
  ctx: SurfacesForObjectContext,
  access: AccessContext,
  loaded: LoadedAnchor,
  lens: string | null
): Source[] {
  const { anchor } = loaded;
  // Read FIRST: `dedupe` keeps the first row naming a surface, so a legacy
  // store the conversions copied onto `attaches` never names it twice.
  const out: Source[] = [
    { source: "attaches", read: () => readAttachedSurfaces(access, anchor) },
  ];
  switch (anchor.kind) {
    case "entity":
      out.push(
        { source: "renderers", read: () => readRenders(ctx, loaded) },
        { source: "entity-body", read: () => readEntityBody(access, loaded) },
        { source: "views", read: () => readEntityBento(access, loaded) },
        {
          source: "cell-relations",
          read: () => readCellRelations(access, anchor),
        }
      );
      break;
    case "profile":
      out.push(
        { source: "renderers", read: () => readRenders(ctx, loaded) },
        {
          source: "views",
          read: () =>
            readViews(
              access,
              anchor,
              or(
                drizzleSql`${views.scopeProfileIds} @> ARRAY[${loaded.profileId}]::uuid[]`,
                drizzleSql`${views.config}->>'profileSlug' = ${loaded.profileSlug}`
              )!,
              () => "pinned"
            ),
        },
        {
          source: "profile-bento",
          read: () => readProfileBentos(ctx, access, loaded, lens),
        }
      );
      break;
    case "workspace":
      out.push(
        {
          source: "views",
          read: () =>
            readViews(
              access,
              anchor,
              and(
                eq(views.workspaceId, anchor.id),
                or(
                  drizzleSql`${views.metadata}->>'homeScope' = 'workspace'`,
                  and(
                    drizzleSql`${views.metadata}->>'homeScope' = 'user'`,
                    eq(views.userId, ctx.userId)
                  ),
                  and(
                    drizzleSql`${views.metadata}->>'scopedSurface' = 'true'`,
                    isNull(views.projectId),
                    drizzleSql`${views.metadata}->>'sessionId' IS NULL`
                  )
                )
              )!,
              () => "home"
            ),
        },
        { source: "start-page", read: () => readStartPage(access, loaded) }
      );
      break;
    case "project":
      out.push(
        {
          source: "views",
          read: () =>
            readViews(access, anchor, eq(views.projectId, anchor.id), (v) =>
              isScopedSurface(v.metadata)
                ? "home"
                : v.exposedAt
                  ? "exposed"
                  : "pinned"
            ),
        },
        { source: "sites", read: () => readSites(access, anchor) }
      );
      break;
    case "session":
      out.push(
        {
          source: "views",
          read: () =>
            readViews(
              access,
              anchor,
              drizzleSql`${views.metadata}->>'sessionId' = ${anchor.id}`,
              () => "home"
            ),
        },
        {
          source: "session-outputs",
          read: () => readSessionOutputs(access, anchor),
        }
      );
      break;
    case "playbook":
      // A playbook's own look was a per-object renderer binding; since P3 it
      // is an attachment (conversion `p3.surfaces.renderer-binding`, and the
      // aliased `synap_promote_cell_to_renderer`), read above.
      break;
    case "track":
      // A goal's only surfaces are the ones attached to it.
      break;
  }
  return out;
}

// ── Mapping helpers ───────────────────────────────────────────────────────

function viewBody(type: string): SurfaceBody {
  if (type === "bento") return "bento";
  if (type === "whiteboard") return "whiteboard";
  return "view";
}

function isScopedSurface(metadata: unknown): boolean {
  return (metadata as Record<string, unknown> | null)?.scopedSurface === true;
}

interface ViewRow {
  id: string;
  name: string;
  type: string;
  metadata: unknown;
  exposedAt: Date | null;
}

function viewRow(
  v: ViewRow,
  anchor: SurfaceAnchor,
  relation: SurfaceRelation,
  source: string
): SurfaceRow {
  const body = viewBody(v.type);
  return {
    id: v.id,
    body,
    relation,
    anchor,
    title: v.name,
    ...(body === "view" ? { viewType: v.type } : {}),
    openUrl: openLink(v.id),
    readOnly: false,
    source,
  };
}

function documentRow(
  d: { id: string; title: string; type: string },
  anchor: SurfaceAnchor,
  relation: SurfaceRelation,
  source: string
): SurfaceRow {
  const html = d.type === "html";
  return {
    id: d.id,
    body: html ? "html" : "document",
    relation,
    anchor,
    title: d.title,
    openUrl: openLink(d.id),
    // An HTML artifact reads pod data through the bridge and never writes.
    readOnly: html,
    source,
  };
}

const VIEW_COLUMNS = {
  id: true,
  name: true,
  type: true,
  metadata: true,
  exposedAt: true,
} as const;

// ── Sources ───────────────────────────────────────────────────────────────

/** Views anchored by `where`, read under the visible floor. */
async function readViews(
  access: AccessContext,
  anchor: SurfaceAnchor,
  where: SQL,
  relationOf: (v: ViewRow) => SurfaceRelation
): Promise<SurfaceRow[]> {
  const rows = await scopedDb(access).findMany<ViewRow>(views, {
    where,
    columns: VIEW_COLUMNS,
  });
  return rows.map((v) => viewRow(v, anchor, relationOf(v), "views"));
}

async function readViewsByIds(
  access: AccessContext,
  ids: string[]
): Promise<ViewRow[]> {
  if (ids.length === 0) return [];
  return scopedDb(access).findMany<ViewRow>(views, {
    where: inArray(views.id, ids),
    columns: VIEW_COLUMNS,
  });
}

/**
 * The kind's look per slot through the ONE renderer reader
 * (`readBoundRenderer`): `renderer_bindings` first, then the legacy stores. A
 * slot answered only by the hardcoded fallback carries no surface.
 */
async function readRenders(
  ctx: SurfacesForObjectContext,
  loaded: LoadedAnchor
): Promise<SurfaceRow[]> {
  const { anchor } = loaded;
  const target = { kind: "profile" as const, slug: loaded.profileSlug! };
  const slots = RENDERER_TARGETS[target.kind].slots;
  const out: SurfaceRow[] = [];
  for (const slot of slots) {
    const bound = await readBoundRenderer({
      target,
      slot,
      userId: ctx.userId,
      workspaceId: loaded.workspaceId,
    });
    if (bound)
      out.push(
        rendererRow(bound.ref, slot, anchor, `renderer:${bound.source}`)
      );
  }
  return out;
}

function rendererRow(
  ref: unknown,
  slot: string,
  anchor: SurfaceAnchor,
  source: string
): SurfaceRow {
  const r = (ref ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  if (r.kind === "view" && str("viewId")) {
    return {
      id: str("viewId"),
      body: "view",
      relation: "renders",
      anchor,
      title: str("viewId"),
      slot,
      openUrl: openLink(str("viewId")),
      readOnly: false,
      source,
    };
  }
  const external = r.kind === "external-app" || r.kind === "iframe-srcdoc";
  const key =
    str("cellKey") || str("adapterKey") || str("appId") || String(r.kind ?? "");
  return {
    id: key,
    body: external ? "app" : "cell",
    relation: "renders",
    anchor,
    title: key,
    ...(external ? {} : { cellKey: key }),
    slot,
    // A renderer has no page of its own: it draws the anchor's page.
    openUrl: openLink(anchor.id),
    readOnly: false,
    source,
  };
}

async function readEntityBody(
  access: AccessContext,
  loaded: LoadedAnchor
): Promise<SurfaceRow[]> {
  const documentId = loaded.entity?.documentId;
  if (!documentId) return [];
  const doc = await scopedDb(access).findFirst<{
    id: string;
    title: string;
    type: string;
  }>(documents, {
    where: eq(documents.id, documentId),
    columns: { id: true, title: true, type: true },
  });
  return doc ? [documentRow(doc, loaded.anchor, "body", "entity-body")] : [];
}

/**
 * The entity's bento (`entities.system_data.bentoViewId`, the view-mode
 * toggle): an ATTACHED surface since P3 (conversion `p3.surfaces.entity-bento`
 * copied each onto `attaches`). Still read because `setEntityViewMode` still
 * writes the old key; `dedupe` folds it into the attachment.
 */
async function readEntityBento(
  access: AccessContext,
  loaded: LoadedAnchor
): Promise<SurfaceRow[]> {
  const id = loaded.entity?.systemData.bentoViewId;
  if (typeof id !== "string" || !id) return [];
  const rows = await readViewsByIds(access, [id]);
  return rows.map((v) => viewRow(v, loaded.anchor, "attached", "views"));
}

/** A kind's bento per space (`workspaces.settings.profileBentoViewIds[slug]`). */
async function readProfileBentos(
  ctx: SurfacesForObjectContext,
  access: AccessContext,
  loaded: LoadedAnchor,
  lens: string | null
): Promise<SurfaceRow[]> {
  const rows = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(
      and(
        lens ? eq(workspaces.id, lens) : undefined,
        userVisibleWhere(workspaces.id, ctx.userId)
      )
    );
  const ids = new Set<string>();
  for (const row of rows) {
    const map = (row.settings as { profileBentoViewIds?: unknown } | null)
      ?.profileBentoViewIds as Record<string, unknown> | undefined;
    const id = map?.[loaded.profileSlug!];
    if (typeof id === "string" && id) ids.add(id);
  }
  const found = await readViewsByIds(access, [...ids]);
  return found.map((v) => viewRow(v, loaded.anchor, "home", "profile-bento"));
}

/** Cell instances linked to the entity (`relations` cell → entity). */
async function readCellRelations(
  access: AccessContext,
  anchor: SurfaceAnchor
): Promise<SurfaceRow[]> {
  const scoped = scopedDb(access);
  const links = await scoped.findMany<{ sourceCellId: string | null }>(
    relations,
    {
      where: and(
        eq(relations.sourceKind, "cell"),
        eq(relations.targetEntityId, anchor.id)
      ),
      columns: { sourceCellId: true },
    }
  );
  const ids = [
    ...new Set(
      links.map((l) => l.sourceCellId).filter((id): id is string => !!id)
    ),
  ];
  if (ids.length === 0) return [];
  const cells = await scoped.findMany<{
    id: string;
    cellType: string;
    name: string | null;
  }>(cellInstances, {
    where: inArray(cellInstances.id, ids),
    columns: { id: true, cellType: true, name: true },
  });
  return cells.map((c) => ({
    id: c.id,
    body: "cell" as const,
    relation: "attached" as const,
    anchor,
    title: c.name || c.cellType,
    cellKey: c.cellType,
    openUrl: openLink(c.id),
    readOnly: false,
    source: "cell-relations",
  }));
}

/** A space's start page (`settings.layout.primarySurface`). */
async function readStartPage(
  access: AccessContext,
  loaded: LoadedAnchor
): Promise<SurfaceRow[]> {
  const layout = loaded.workspaceSettings?.layout as
    { primarySurface?: Record<string, unknown> | null } | undefined;
  const ps = layout?.primarySurface;
  if (!ps || typeof ps !== "object") return [];
  const { anchor } = loaded;
  const title = typeof ps.title === "string" ? ps.title : "";
  const base = {
    relation: "home" as const,
    anchor,
    readOnly: false,
    source: "start-page",
  };
  switch (ps.kind) {
    case "view": {
      const [v] = await readViewsByIds(access, [String(ps.viewId)]);
      // A start page naming a view the caller cannot see shows nothing.
      return v ? [viewRow(v, anchor, "home", "start-page")] : [];
    }
    case "cell":
      return [
        {
          ...base,
          id: String(ps.cellKey),
          body: "cell",
          title: title || String(ps.cellKey),
          cellKey: String(ps.cellKey),
          openUrl: openLink(anchor.id),
        },
      ];
    case "url":
      return [
        {
          ...base,
          id: String(ps.url),
          body: "app",
          title: title || String(ps.url),
          openUrl: String(ps.url),
          readOnly: true,
        },
      ];
    case "app":
      return [
        {
          ...base,
          id: String(ps.appId),
          body: "app",
          title: title || String(ps.appId),
          openUrl:
            ps.rendererType === "external" && typeof ps.url === "string"
              ? ps.url
              : openLink(anchor.id),
        },
      ];
    default:
      return [];
  }
}

/** What a session produced (the `artifacts` ledger), swept ones left out. */
async function readSessionOutputs(
  access: AccessContext,
  anchor: SurfaceAnchor
): Promise<SurfaceRow[]> {
  const scoped = scopedDb(access);
  const rows = await scoped.findMany<{
    id: string;
    kind: string;
    refId: string | null;
    cellKey: string | null;
    title: string;
    state: string;
  }>(artifacts, {
    where: eq(artifacts.sessionId, anchor.id),
    columns: {
      id: true,
      kind: true,
      refId: true,
      cellKey: true,
      title: true,
      state: true,
    },
  });
  const live = rows.filter((a) => a.state !== "swept");
  const viewIds = live
    .filter((a) => a.kind === "view" && a.refId)
    .map((a) => a.refId!);
  const docIds = live
    .filter((a) => a.kind === "document" && a.refId)
    .map((a) => a.refId!);
  const [viewsFound, docsFound] = await Promise.all([
    readViewsByIds(access, viewIds),
    docIds.length
      ? scoped.findMany<{ id: string; title: string; type: string }>(
          documents,
          {
            where: inArray(documents.id, docIds),
            columns: { id: true, title: true, type: true },
          }
        )
      : Promise.resolve([]),
  ]);
  const viewById = new Map(viewsFound.map((v) => [v.id, v]));
  const docById = new Map(docsFound.map((d) => [d.id, d]));
  const source = "session-outputs";
  const out: SurfaceRow[] = [];
  for (const a of live) {
    if (a.kind === "view" && a.refId) {
      const v = viewById.get(a.refId);
      if (v) out.push(viewRow(v, anchor, "session-output", source));
    } else if (a.kind === "document" && a.refId) {
      const d = docById.get(a.refId);
      if (d) out.push(documentRow(d, anchor, "session-output", source));
    } else if (a.kind === "cell") {
      out.push({
        id: a.refId ?? a.id,
        body: "cell",
        relation: "session-output",
        anchor,
        title: a.title,
        ...(a.cellKey ? { cellKey: a.cellKey } : {}),
        openUrl: openLink(a.refId ?? anchor.id),
        readOnly: false,
        source,
      });
    } else if (a.kind === "url" && a.refId) {
      out.push({
        id: a.id,
        body: "app",
        relation: "session-output",
        anchor,
        title: a.title,
        openUrl: a.refId,
        readOnly: true,
        source,
      });
    }
    // entity / automation / playbook outputs are records, not UI.
  }
  return out;
}

/** A project's Site: its live (not revoked) public site row (0336). */
async function readSites(
  access: AccessContext,
  anchor: SurfaceAnchor
): Promise<SurfaceRow[]> {
  const rows = await scopedDb(access).findMany<{
    id: string;
    state: string | null;
    siteConfig: Record<string, unknown> | null;
  }>(resourceShares, {
    where: and(
      eq(resourceShares.resourceType, "project"),
      eq(resourceShares.resourceId, anchor.id),
      eq(resourceShares.audience, "public"),
      isNull(resourceShares.siteShareId),
      isNull(resourceShares.revokedAt)
    ),
    columns: { id: true, state: true, siteConfig: true },
  });
  return rows.map((s) => {
    const title = s.siteConfig?.title;
    return {
      id: s.id,
      body: "site" as const,
      relation: "exposed" as const,
      anchor,
      title:
        typeof title === "string" && title
          ? title
          : `Site (${s.state ?? "draft"})`,
      // The public address is a token shown once; the project page manages it.
      openUrl: openLink(anchor.id),
      readOnly: true,
      source: "sites",
    };
  });
}
