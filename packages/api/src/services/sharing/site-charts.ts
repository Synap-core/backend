/**
 * CHARTS INTO A SITE — the owner side of the public chart doors.
 *
 * A chart is a CELL INSTANCE (`cell_instances`: `cell_type` = its cellKey,
 * `config` = its props, optionally `data` + `capturedAt`). Publishing it into
 * a SITE writes a member row of that site (0336 + 0397):
 *
 *   resource_type = 'cell', resource_id = the cell instance,
 *   published_collection = '@charts' (never a profile slug),
 *   public_id (minted once), public_slug (optional),
 *   published_properties = the chart payload {@link ChartPayload}.
 *
 * The site's token addresses it (`GET /public/sites/:token/charts[/:slug]`,
 * `public-site-charts.ts`), so nothing new is minted: an agent's batch is ONE
 * proposal the person approves, and an approved chart is live at once.
 *
 * TWO MODES, chosen per chart (founder, 2026-11-04: "both, chosen with a
 * setting"):
 *   - `snapshot`: `data` + `capturedAt` are FROZEN here. They come from the
 *     cell's own inline `data` when it has one, else from the chart's query
 *     run ONCE now, as the publisher, through the live chart's own read
 *     (`liveChartReader`, `entities.list`, 500 rows) and shaper
 *     (`shapeChartEntities`). Publishing again refreshes them.
 *   - `live`: only a pod chart key whose catalog binding supports `query`.
 *     Nothing but the props is stored; each public read re-runs the query as
 *     the publisher (bounded and cached, see the read). A custom cell (e.g.
 *     `sillage-histogram`) has no query the pod can run, so it is snapshot
 *     only.
 * Either way the PROPS are frozen here: editing the cell later changes
 * nothing public until the next publish.
 *
 * WHAT MAY LEAVE. A chart is governed by its space's `view` kind (its
 * public read must be `direct`), and the chart must live
 * in the site's HOME space. No UUID ever leaves: a prop whose value holds one
 * is dropped, and data holding one is refused (a live read holding one fails
 * closed). The payload is capped at {@link CHART_PAYLOAD_MAX_BYTES}.
 */

import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import {
  getDb,
  and,
  eq,
  inArray,
  isNull,
  isUniqueViolation,
  uniqueViolationConstraint,
} from "@synap/database";
import { cellInstances, resourceShares } from "@synap/database/schema";
import {
  WIDGET_BY_KEY,
  chartPropsMadeLive,
  dataBindingFor,
  hasChartSnapshot,
  isChartCellKey,
  parseChartSnapshot,
  CHART_DATA_SHAPE_BY_KEY,
  shapeChartEntities,
} from "@synap-core/types/renderables";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { auditLog } from "../../utils/audit-log.js";
import { liveChartReader } from "../document-charts/freeze-charts-verb.js";
import { resolveExposurePolicy } from "./exposure-policy.js";
import { isSiteChartLive } from "./publication-live.js";
import { grantWriteDenial } from "../../utils/grant-write-check.js";
import { SLUG_MAX_LENGTH, SLUG_RE, slugify } from "./site-config.js";
import {
  assertCanNarrowSite,
  assertSitePolicy,
  loadProject,
  loadSettings,
  loadSiteById,
  loadSiteToWiden,
  mintPublicId,
  SLUG_INDEX,
} from "./site-service.js";
import { agentOf, type ShareActor } from "./share-service.js";

type Db = Awaited<ReturnType<typeof getDb>>;

const notFound = (what: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
const badRequest = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

/** The member collection every chart row carries (0397 CHECK). */
export const CHART_COLLECTION = "@charts";
/** At most this many charts per publish call (same bound as records). */
export const SITE_PUBLISH_MAX_CHARTS = 200;
/** The serialized payload a chart may hold (props + data). */
export const CHART_PAYLOAD_MAX_BYTES = 256 * 1024;
/** A cellKey: the catalog's and custom cells' shape. */
export const CELL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const CHART_MODES = ["snapshot", "live"] as const;
export type ChartMode = (typeof CHART_MODES)[number];

/**
 * What a chart member row stores in `published_properties`. `data` +
 * `capturedAt` only for a snapshot; a live chart's are read at serve time.
 */
export interface ChartPayload {
  v: 1;
  mode: ChartMode;
  cellKey: string;
  title?: string;
  props: Record<string, unknown>;
  data?: unknown;
  capturedAt?: string;
}

const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Does this JSON value hold an internal id anywhere (keys included)? */
export function holdsUuid(value: unknown): boolean {
  if (value === undefined) return false;
  return UUID_ANYWHERE.test(JSON.stringify(value));
}

/** The props that may leave: no snapshot keys, no prop holding an id. */
export function publicChartProps(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(chartPropsMadeLive(config))) {
    if (value === undefined || holdsUuid(key) || holdsUuid(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Can the pod re-run this cellKey's query (live mode, or a freeze at publish)? */
export function chartHasQuery(cellKey: string): boolean {
  if (!isChartCellKey(cellKey)) return false;
  const def = WIDGET_BY_KEY[cellKey];
  return !!def && !!dataBindingFor(def)?.supports.includes("query");
}

const isDate = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * Decode a stored payload, fail-closed: anything unreadable is `null` (the
 * public read then answers the uniform 404, never a half chart).
 */
export function readChartPayload(raw: unknown): ChartPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (p.mode !== "snapshot" && p.mode !== "live") return null;
  if (typeof p.cellKey !== "string" || !CELL_KEY_RE.test(p.cellKey))
    return null;
  if (!p.props || typeof p.props !== "object" || Array.isArray(p.props))
    return null;
  if (p.title !== undefined && typeof p.title !== "string") return null;
  if (p.mode === "snapshot") {
    if (!("data" in p) || !isDate(p.capturedAt)) return null;
  } else if (!chartHasQuery(p.cellKey)) {
    return null;
  }
  return {
    v: 1,
    mode: p.mode,
    cellKey: p.cellKey,
    ...(typeof p.title === "string" ? { title: p.title } : {}),
    props: p.props as Record<string, unknown>,
    ...(p.mode === "snapshot"
      ? { data: p.data, capturedAt: p.capturedAt as string }
      : {}),
  };
}

/** Rows of the chart's own query, shaped as it draws them, read as `userId`. */
export async function readLiveChartData(
  ctx: { userId: string; workspaceId: string },
  cellKey: string,
  props: Record<string, unknown>,
  now: Date,
): Promise<unknown> {
  if (!isChartCellKey(cellKey)) {
    throw new Error(`"${cellKey}" has no query the pod can run`);
  }
  const profileSlug =
    typeof props.profileSlug === "string" && props.profileSlug
      ? props.profileSlug
      : undefined;
  const rows = await liveChartReader(ctx)(profileSlug);
  return shapeChartEntities(cellKey, rows as never, props, now);
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface ChartPublishItem {
  cellInstanceId: string;
  mode: ChartMode;
  /** The URL slug; default: the cell's name, slugified. Null = public id only. */
  slug?: string | null;
}

/** One chart's validated publish into a site. */
export interface ChartMemberPlan {
  cellInstanceId: string;
  workspaceId: string;
  slug: string | null;
  mode: ChartMode;
  cellKey: string;
  title: string | null;
  props: Record<string, unknown>;
  /** A snapshot whose data is the cell's own (`freeze` false) or is read now. */
  data?: unknown;
  capturedAt?: string;
  /** Snapshot of a query chart with no inline data: read it at apply time. */
  freeze: boolean;
}

export interface ChartSkip {
  cellInstanceId: string;
  code: string;
  reason: string;
}

export interface ChartPublishPlan {
  siteId: string;
  projectId: string;
  homeWorkspaceId: string;
  members: ChartMemberPlan[];
  skipped: ChartSkip[];
}

function payloadOf(
  m: ChartMemberPlan,
  data: unknown,
  capturedAt: string | undefined,
): ChartPayload {
  return {
    v: 1,
    mode: m.mode,
    cellKey: m.cellKey,
    ...(m.title ? { title: m.title } : {}),
    props: m.props,
    ...(m.mode === "snapshot" ? { data, capturedAt } : {}),
  };
}

function assertPayloadFits(payload: ChartPayload): void {
  if (holdsUuid(payload.data)) {
    throw badRequest(
      "This chart's data holds internal ids (a UUID), so it cannot be published. Label it with names instead.",
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > CHART_PAYLOAD_MAX_BYTES) {
    throw badRequest(
      `This chart is ${Math.ceil(bytes / 1024)} KB; a published chart holds at most ${CHART_PAYLOAD_MAX_BYTES / 1024} KB. Aggregate its data first.`,
    );
  }
}

async function planChartMember(
  database: Db,
  userId: string,
  homeWorkspaceId: string,
  item: ChartPublishItem,
  settings: unknown,
): Promise<ChartMemberPlan> {
  if (!(CHART_MODES as readonly string[]).includes(item.mode)) {
    throw badRequest(`mode must be "snapshot" or "live".`);
  }
  const [cell] = await database
    .select({
      id: cellInstances.id,
      workspaceId: cellInstances.workspaceId,
      userId: cellInstances.userId,
      cellType: cellInstances.cellType,
      config: cellInstances.config,
      name: cellInstances.name,
      isTemplate: cellInstances.isTemplate,
    })
    .from(cellInstances)
    .where(eq(cellInstances.id, item.cellInstanceId))
    .limit(1);
  if (!cell) throw notFound("Chart");
  if (cell.isTemplate) {
    throw badRequest("A template cell is not a chart; publish an instance.");
  }
  if (cell.workspaceId !== homeWorkspaceId) {
    throw badRequest(
      "A chart is published into the site of its own space: this cell lives in another space than the site's home.",
    );
  }
  await assertWorkspaceWrite(database, userId, {
    workspaceId: cell.workspaceId,
    ownerId: cell.userId,
  });
  if (resolveExposurePolicy(settings).view.public.read !== "direct") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This workspace's exposure policy does not allow publishing a view (a chart is published under the view policy).",
    });
  }
  const cellKey = cell.cellType;
  if (!CELL_KEY_RE.test(cellKey)) {
    throw badRequest(`"${cellKey}" is not a cell key a site can draw.`);
  }

  let slug: string | null;
  if (item.slug === null) slug = null;
  else if (item.slug !== undefined) {
    if (
      typeof item.slug !== "string" ||
      !SLUG_RE.test(item.slug) ||
      item.slug.length > SLUG_MAX_LENGTH
    ) {
      throw badRequest(
        "A slug is lowercase words joined by single hyphens (a-z, 0-9), at most 96 characters.",
      );
    }
    slug = item.slug;
  } else slug = slugify(cell.name);

  const config = (cell.config ?? {}) as Record<string, unknown>;
  const props = publicChartProps(config);
  const base = {
    cellInstanceId: cell.id,
    workspaceId: cell.workspaceId,
    slug,
    mode: item.mode,
    cellKey,
    title: cell.name ?? null,
    props,
  };

  if (item.mode === "live") {
    if (!chartHasQuery(cellKey)) {
      throw badRequest(
        `Only a pod chart with a query (chart-bar, chart-line, …) can be live; "${cellKey}" can be published as a snapshot.`,
      );
    }
    return { ...base, freeze: false };
  }

  if (hasChartSnapshot(config)) {
    let capturedAt: string | undefined;
    if (isChartCellKey(cellKey)) {
      const parsed = parseChartSnapshot(
        CHART_DATA_SHAPE_BY_KEY[cellKey],
        config,
      );
      if (!parsed.ok) throw badRequest(`This chart's data: ${parsed.message}`);
      capturedAt = parsed.capturedAt;
    } else if (config.capturedAt !== undefined) {
      if (!isDate(config.capturedAt)) {
        throw badRequest(
          "capturedAt must be an ISO date (when the numbers were taken).",
        );
      }
      capturedAt = config.capturedAt;
    }
    const plan = {
      ...base,
      data: config.data,
      capturedAt: new Date(capturedAt ?? Date.now()).toISOString(),
      freeze: false,
    };
    assertPayloadFits(payloadOf(plan, plan.data, plan.capturedAt));
    return plan;
  }
  if (chartHasQuery(cellKey)) return { ...base, freeze: true };
  throw badRequest(
    `This cell has no data to publish: no inline \`data\` in its config, and "${cellKey}" has no query the pod can run.`,
  );
}

/**
 * Validate + authorize a batch for `userId` (the human it is for). Re-run
 * verbatim by the approval executor, so a policy tightened while a proposal
 * waited skips the chart, never publishes it.
 */
export async function planChartsPublish(
  database: Db,
  userId: string,
  req: { siteId: string; charts: readonly ChartPublishItem[] },
  opts: { strict?: boolean } = {},
): Promise<ChartPublishPlan> {
  const seen = new Set<string>();
  const items = req.charts.filter((c) => {
    if (seen.has(c.cellInstanceId)) return false;
    seen.add(c.cellInstanceId);
    return true;
  });
  if (items.length === 0 || items.length > SITE_PUBLISH_MAX_CHARTS) {
    throw badRequest(
      `Publish between 1 and ${SITE_PUBLISH_MAX_CHARTS} charts at a time.`,
    );
  }
  const { site, project, home } = await loadSiteToWiden(
    database,
    userId,
    req.siteId,
  );
  const settings = await loadSettings(database, home);
  assertSitePolicy(settings);
  const members: ChartMemberPlan[] = [];
  const skipped: ChartSkip[] = [];
  const slugsInBatch = new Set<string>();
  for (const item of items) {
    try {
      const member = await planChartMember(
        database,
        userId,
        home,
        item,
        settings,
      );
      if (member.slug) {
        if (slugsInBatch.has(member.slug)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `SITE_SLUG_TAKEN: two charts of this batch want the slug "${member.slug}".`,
          });
        }
        slugsInBatch.add(member.slug);
      }
      members.push(member);
    } catch (err) {
      if (!(err instanceof TRPCError) || opts.strict) throw err;
      skipped.push({
        cellInstanceId: item.cellInstanceId,
        code: err.code,
        reason: err.message,
      });
    }
  }
  return {
    siteId: site.id,
    projectId: project.id,
    homeWorkspaceId: home,
    members,
    skipped,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface PublishedChart {
  cellInstanceId: string;
  publicId: string;
  slug: string | null;
  mode: ChartMode;
  status: "published" | "republished";
}

/**
 * Write an authorized batch: each chart's LIVE member row of this site is
 * re-snapshotted (`public_id` kept), or a new member row is inserted. A
 * snapshot of a query chart is read NOW, as the publisher; a live chart is
 * trial-read once, so a query that cannot run is refused here rather than
 * served as a failure. A failed read or a lost slug skips that chart only.
 */
export async function applyChartsPublish(
  database: Db,
  plan: ChartPublishPlan,
  opts: {
    userId: string;
    agentUserId?: string | null;
    sourceProposalId?: string;
  },
): Promise<{
  published: PublishedChart[];
  skipped: ChartSkip[];
  rowsWritten: number;
  ids: string[];
}> {
  const published: PublishedChart[] = [];
  const skipped: ChartSkip[] = [];
  const ids: string[] = [];
  const skip = (m: ChartMemberPlan, code: string, reason: string) =>
    skipped.push({ cellInstanceId: m.cellInstanceId, code, reason });

  for (const m of plan.members) {
    const now = new Date();
    let payload: ChartPayload;
    try {
      if (m.mode === "snapshot" && !m.freeze) {
        payload = payloadOf(m, m.data, m.capturedAt);
      } else {
        const data = await readLiveChartData(
          { userId: opts.userId, workspaceId: m.workspaceId },
          m.cellKey,
          m.props,
          now,
        );
        payload =
          m.mode === "snapshot"
            ? payloadOf(m, data, now.toISOString())
            : payloadOf(m, undefined, undefined);
        // A live chart is checked on its trial read too.
        if (m.mode === "live" && holdsUuid(data)) {
          throw badRequest(
            "This chart's live data holds internal ids (a UUID), so it cannot be published. Group it by a named field instead.",
          );
        }
      }
      assertPayloadFits(payload);
    } catch (err) {
      if (err instanceof TRPCError) skip(m, err.code, err.message);
      else
        skip(
          m,
          "READ_FAILED",
          `This chart's data could not be read now: ${err instanceof Error ? err.message : String(err)}`,
        );
      continue;
    }

    const [live] = await database
      .select({
        id: resourceShares.id,
        state: resourceShares.state,
        audience: resourceShares.audience,
        resourceType: resourceShares.resourceType,
        revokedAt: resourceShares.revokedAt,
        expiresAt: resourceShares.expiresAt,
        publishedAt: resourceShares.publishedAt,
        siteShareId: resourceShares.siteShareId,
      })
      .from(resourceShares)
      .where(
        and(
          eq(resourceShares.siteShareId, plan.siteId),
          eq(resourceShares.resourceId, m.cellInstanceId),
          isNull(resourceShares.revokedAt),
        ),
      )
      .limit(1);
    let row: { id: string; publicId: string | null } | undefined;
    try {
      if (live) {
        [row] = await database
          .update(resourceShares)
          .set({
            state: "published",
            publishedAt: now,
            publishedBy: opts.userId,
            publishedProperties: payload as unknown as Record<string, unknown>,
            publicSlug: m.slug,
            updatedAt: now,
          })
          .where(
            and(
              eq(resourceShares.id, live.id),
              isNull(resourceShares.revokedAt),
            ),
          )
          .returning({
            id: resourceShares.id,
            publicId: resourceShares.publicId,
          });
      } else {
        [row] = await database
          .insert(resourceShares)
          .values({
            resourceType: "cell",
            resourceId: m.cellInstanceId,
            workspaceId: m.workspaceId,
            audience: "public",
            anchorProjectId: null,
            state: "published",
            publishedAt: now,
            publishedBy: opts.userId,
            publishedDocumentVersionId: null,
            publishedProperties: payload as unknown as Record<string, unknown>,
            createdBy: opts.userId,
            permissions: { read: true },
            // A member has no token of its own: the site's token addresses it.
            tokenHash: null,
            tokenPrefix: null,
            siteShareId: plan.siteId,
            publishedCollection: CHART_COLLECTION,
            publicId: mintPublicId(),
            publicSlug: m.slug,
          })
          .returning({
            id: resourceShares.id,
            publicId: resourceShares.publicId,
          });
      }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const slugLost = uniqueViolationConstraint(err) === SLUG_INDEX;
      skip(
        m,
        slugLost ? "SITE_SLUG_TAKEN" : "CONFLICT",
        slugLost
          ? `SITE_SLUG_TAKEN: the slug "${m.slug}" is already used by another chart of this site.`
          : "This chart was published into the site concurrently; publish it again.",
      );
      continue;
    }
    if (!row) {
      skip(
        m,
        "CONFLICT",
        "This chart's publication was revoked meanwhile; publish again.",
      );
      continue;
    }
    ids.push(row.id);
    published.push({
      cellInstanceId: m.cellInstanceId,
      publicId: row.publicId!,
      slug: m.slug,
      mode: m.mode,
      status:
        live && isSiteChartLive({ ...live, hasToken: false }, now.getTime())
          ? "republished"
          : "published",
    });
  }
  if (ids.length > 0) {
    auditLog({
      subjectType: "sharing",
      action: "update",
      phase: "completed",
      subjectId: plan.siteId,
      userId: opts.userId,
      agentUserId: opts.agentUserId ?? undefined,
      proposalId: opts.sourceProposalId,
      workspaceId: plan.homeWorkspaceId,
      // Ids, modes and codes only — never values.
      data: {
        op: "publish_charts",
        siteId: plan.siteId,
        projectId: plan.projectId,
        charts: published.map((p) => ({
          cellInstanceId: p.cellInstanceId,
          mode: p.mode,
        })),
        skipped: [...plan.skipped, ...skipped].map((k) => ({
          cellInstanceId: k.cellInstanceId,
          code: k.code,
        })),
      },
    });
  }
  return { published, skipped, rowsWritten: ids.length, ids };
}

// ── The doors ────────────────────────────────────────────────────────────────

export type PublishChartsResult =
  | {
      status: "proposed";
      proposalId: string;
      siteId: string;
      skipped: ChartSkip[];
    }
  | {
      status: "published" | "none";
      siteId: string;
      published: PublishedChart[];
      skipped: ChartSkip[];
      rowsWritten: number;
    };

/**
 * THE chart publish door. A human is applied directly; an agent files ONE
 * proposal for the batch (ADMIN floor on `share.create`, `op:
 * "publish_charts"`, ids and modes only). A one-chart publish that is refused
 * throws; a batch reports each refused chart.
 */
export async function publishChartsToSite(
  actor: ShareActor,
  req: { siteId: string; charts: ChartPublishItem[]; reasoning?: string },
): Promise<PublishChartsResult> {
  const agentUserId = agentOf(actor);
  if (actor.keyType && !agentUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Publishing to a site needs a signed-in person or an agent key (run `synap init`); this API key is not attributed to either.",
    });
  }
  const strict = new Set(req.charts.map((c) => c.cellInstanceId)).size === 1;
  const database = await getDb();
  const plan = await planChartsPublish(database, actor.userId, req, {
    strict,
  });
  if (plan.members.length === 0) {
    return {
      status: "none",
      siteId: plan.siteId,
      published: [],
      skipped: plan.skipped,
      rowsWritten: 0,
    };
  }
  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: agentUserId ?? undefined,
    workspaceId: plan.homeWorkspaceId,
    projectId: plan.projectId,
    subjectType: "share",
    action: "create",
    source: actor.source ?? undefined,
    reasoning: actor.reasoning ?? req.reasoning,
    data: {
      id: randomUUID(),
      op: "publish_charts" as const,
      audience: "public" as const,
      resourceType: "cell" as const,
      siteId: plan.siteId,
      charts: plan.members.map((m) => ({
        cellInstanceId: m.cellInstanceId,
        mode: m.mode,
        slug: m.slug,
      })),
      projectId: plan.projectId,
      workspaceId: plan.homeWorkspaceId,
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      siteId: plan.siteId,
      skipped: plan.skipped,
    };
  }
  const applied = await applyChartsPublish(database, plan, {
    userId: actor.userId,
    agentUserId,
  });
  if (strict && applied.published.length === 0 && applied.skipped[0]) {
    const [s] = applied.skipped;
    throw new TRPCError({
      code: s.code === "SITE_SLUG_TAKEN" ? "CONFLICT" : "BAD_REQUEST",
      message: s.reason,
    });
  }
  return {
    status: applied.published.length > 0 ? "published" : "none",
    siteId: plan.siteId,
    published: applied.published,
    skipped: [...plan.skipped, ...applied.skipped],
    rowsWritten: applied.rowsWritten,
  };
}

/**
 * Take charts off ONE site (back to draft: the uniform 404; public id and slug
 * kept, so publishing again restores the same URL). Direct for everyone: it
 * only narrows.
 */
export async function unpublishChartsFromSite(
  actor: ShareActor,
  req: { siteId: string; cellInstanceIds: string[] },
): Promise<{ status: "unpublished" | "none"; count: number }> {
  if (
    req.cellInstanceIds.length === 0 ||
    req.cellInstanceIds.length > SITE_PUBLISH_MAX_CHARTS
  ) {
    throw badRequest(
      `Unpublish between 1 and ${SITE_PUBLISH_MAX_CHARTS} charts at a time.`,
    );
  }
  const database = await getDb();
  const site = await loadSiteById(database, req.siteId);
  const project = await loadProject(database, site.resourceId);
  await assertCanNarrowSite(database, actor.userId, site, project);
  // A key narrowed to some spaces or projects takes charts off only inside
  // its grant (no grant on the request = a person, nothing to check).
  const denied = await grantWriteDenial({
    subjectType: "share",
    action: "update",
    workspaceId: site.workspaceId ?? undefined,
    projectId: site.resourceId,
    data: { op: "unpublish_charts", siteId: site.id },
  });
  if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
  const updated = await database
    .update(resourceShares)
    .set({ state: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(resourceShares.siteShareId, site.id),
        eq(resourceShares.resourceType, "cell"),
        inArray(resourceShares.resourceId, [...new Set(req.cellInstanceIds)]),
        eq(resourceShares.state, "published"),
        isNull(resourceShares.revokedAt),
      ),
    )
    .returning({ id: resourceShares.id });
  if (updated.length > 0) {
    auditLog({
      subjectType: "sharing",
      action: "update",
      phase: "completed",
      subjectId: site.id,
      userId: actor.userId,
      agentUserId: agentOf(actor) ?? undefined,
      workspaceId: site.workspaceId ?? undefined,
      data: {
        op: "unpublish_charts",
        siteId: site.id,
        count: updated.length,
      },
    });
  }
  return {
    status: updated.length > 0 ? "unpublished" : "none",
    count: updated.length,
  };
}
