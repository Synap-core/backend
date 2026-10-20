/**
 * THE SITE DOORS — "a published project is a site" (collection door, C1a).
 * Every owner site door calls this module: tRPC `shares.configureSite` /
 * `publishSite` / `rotateSiteToken` / `unpublishSite` / `revokeSite` /
 * `siteStatus`, Hub REST `/shares/sites*`, and the `share/create` approval
 * executor (`op: "configure_site"`, an agent's request).
 *
 * WHAT A SITE IS (0336). ONE `resource_shares` row: `resource_type =
 * 'project'`, `resource_id` = the project, `audience = 'public'`,
 * `site_share_id` NULL, `workspace_id` = the site's HOME SPACE. It reuses the
 * publication machinery of W3 unchanged: a TOKEN (shown once, stored as its
 * SHA-256), `state` draft | published, revoke-is-permanent (the 0336 trigger
 * also freezes the site columns). Records published INTO a site are their own
 * member rows (`site_share_id` = the site row), written from C1b on.
 *
 * THE HOME SPACE governs the site: its exposure policy's dormant
 * `kinds.project.public` cell must say `read: 'direct'` before a site can be
 * configured or go live, its `fields` allowlist is what the site's public
 * metadata may hold (`title` = the project's name, `description`), and its
 * public-doors switch can close the site. It is the project's own workspace
 * when it has one; a pod-wide project's owner must name one. A project's
 * linked spaces are an index, not an ACL, and are never consulted.
 *
 * LIFECYCLE.
 *   configure — create the site row (draft, no token) or replace its
 *               `site_config`, and re-snapshot its public metadata. Human
 *               owner: direct. Agent: ONE `share/create` proposal (ADMIN floor,
 *               `op: "configure_site"`); approval writes the row WITHOUT a
 *               token, so an agent never holds the public secret.
 *   go live   — `publishSite`: published + a fresh metadata snapshot; mints the
 *               token the FIRST time (shown once). Publishing a draft site
 *               again keeps its token, so the same URL comes back. Signed-in
 *               human only (like `rotateLink`), no Hub REST door.
 *   rotate    — `rotateSiteToken`: a new token; the old one answers 404 at
 *               once. Signed-in human only, no Hub REST door.
 *   unpublish — `unpublishSite`: back to draft; every site door answers the
 *               uniform 404; members untouched; the token is kept. Direct for
 *               everyone (it only narrows).
 *   revoke    — `revokeSite`: permanent. In the SAME transaction every
 *               unrevoked member row of the site is revoked too, so no member
 *               outlives its site and a new site never inherits one. Direct
 *               for everyone. A new site = a new row and a new token.
 *
 * AUTHZ on LOADED rows only (never a request-supplied workspace id):
 *   widening (configure, go live, rotate) = administer the project (its owner,
 *   or an owner/admin of the home space) AND write the home space;
 *   narrowing (unpublish, revoke, status) = either one (`assertCanNarrow`).
 *
 * GOVERNANCE. The gate is the existing ADMIN-floored `share/create` with
 * `audience: 'public'` and an `op`, carrying the site's PROJECT (gate input
 * `projectId` + `data.projectId`): a project-narrowed agent key may propose a
 * site for its own project and is refused (not proposed) for another. W3's
 * record publish carries no project, so such a key is denied there.
 */

import { TRPCError } from "@trpc/server";
import { randomBytes, randomUUID } from "node:crypto";
import { getDb, and, asc, desc, eq, inArray, isNull } from "@synap/database";
import {
  entities,
  profiles,
  projects,
  relations,
  resourceShares,
  workspaces,
} from "@synap/database/schema";
import { ne } from "drizzle-orm";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { grantWriteDenial } from "../../utils/grant-write-check.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { auditLog } from "../../utils/audit-log.js";
import { generateShareToken, hashToken } from "../../utils/share-token.js";
import { assertAnchorAdmin } from "./anchor-admin.js";
import {
  resolveExposurePolicy,
  resolvePublicFields,
} from "./exposure-policy.js";
import { isPublicationLive, isSiteLive } from "./publication-live.js";
import {
  buildPublishedSnapshot,
  latestCheckpointId,
} from "./publish-service.js";
import {
  resolveSiteConfig,
  SITE_PUBLISHED_AT_SORT,
  SiteConfigV1Schema,
  slugify,
  type SiteConfigV1,
} from "./site-config.js";
import {
  liveMemberCounts,
  liveMemberWhere,
  openMemberWorkspaces,
} from "./site-members.js";
import { projectPublishedProperties } from "./public-read.js";
import {
  agentOf,
  assertCanNarrow,
  assertHumanSession,
  type ShareActor,
} from "./share-service.js";

type Db = Awaited<ReturnType<typeof getDb>>;

const notFound = (what: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
const badRequest = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

// ── Loading ──────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  workspaceId: string | null;
  userId: string;
  name: string;
  description: string | null;
}

async function loadProject(
  database: Db,
  projectId: string
): Promise<ProjectRow | null> {
  const [row] = await database
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      userId: projects.userId,
      name: projects.name,
      description: projects.description,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

async function loadSettings(database: Db, workspaceId: string) {
  const [ws] = await database
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw notFound("Workspace");
  return ws.settings as unknown;
}

const SITE_COLUMNS = {
  id: resourceShares.id,
  resourceType: resourceShares.resourceType,
  resourceId: resourceShares.resourceId,
  workspaceId: resourceShares.workspaceId,
  audience: resourceShares.audience,
  state: resourceShares.state,
  siteShareId: resourceShares.siteShareId,
  siteConfig: resourceShares.siteConfig,
  publishedAt: resourceShares.publishedAt,
  publishedProperties: resourceShares.publishedProperties,
  tokenHash: resourceShares.tokenHash,
  tokenPrefix: resourceShares.tokenPrefix,
  revokedAt: resourceShares.revokedAt,
  expiresAt: resourceShares.expiresAt,
  createdBy: resourceShares.createdBy,
} as const;

/** Where a row is a SITE row: a public project row that is not a member. */
const siteRowWhere = () =>
  and(
    eq(resourceShares.resourceType, "project"),
    eq(resourceShares.audience, "public"),
    isNull(resourceShares.siteShareId)
  );

type SiteRow = Awaited<ReturnType<typeof loadSiteById>>;

/** A site row by id (revoked included), or NOT_FOUND. */
async function loadSiteById(database: Db, siteId: string) {
  const [row] = await database
    .select(SITE_COLUMNS)
    .from(resourceShares)
    .where(and(eq(resourceShares.id, siteId), siteRowWhere()))
    .limit(1);
  if (!row) throw notFound("Site");
  return row;
}

/** The project's LIVE (unrevoked) site row, or null. One per project (0336 index). */
async function liveSiteOfProject(database: Db, projectId: string) {
  const [row] = await database
    .select(SITE_COLUMNS)
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.resourceId, projectId),
        siteRowWhere(),
        isNull(resourceShares.revokedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

// ── AuthZ ────────────────────────────────────────────────────────────────────

/** Widening: administer the project AND write its home space. */
async function assertCanWidenSite(
  database: Db,
  userId: string,
  project: { userId: string },
  homeWorkspaceId: string
): Promise<void> {
  await assertAnchorAdmin(database, userId, {
    workspaceId: homeWorkspaceId,
    userId: project.userId,
  });
  await assertWorkspaceWrite(database, userId, {
    workspaceId: homeWorkspaceId,
  });
}

/** Narrowing: administer the project OR write the home space. */
async function assertCanNarrowSite(
  database: Db,
  userId: string,
  site: SiteRow,
  project: ProjectRow | null
): Promise<void> {
  if (!site.workspaceId) throw notFound("Site");
  // A deleted project leaves the site's creator as the only owner on record.
  const ownerId = project?.userId ?? site.createdBy;
  await assertCanNarrow(
    database,
    userId,
    {
      kind: "project",
      id: site.resourceId,
      workspaceId: site.workspaceId,
      ownerId,
    },
    { id: site.resourceId, workspaceId: site.workspaceId, userId: ownerId }
  );
}

/** The home space's policy must allow publishing a project (the site). */
function assertSitePolicy(settings: unknown): void {
  if (resolveExposurePolicy(settings).project.public.read !== "direct") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This workspace's exposure policy does not allow publishing a project as a site.",
    });
  }
}

// ── Plan (configure) ─────────────────────────────────────────────────────────

export interface ConfigureSiteRequest {
  projectId: string;
  /** Required only for a pod-wide project (no workspace of its own). */
  homeWorkspaceId?: string | null;
  config: unknown;
}

/** The validated, authorized plan — what the gate carries and approval replays. */
export interface SitePlan {
  projectId: string;
  homeWorkspaceId: string;
  config: SiteConfigV1;
}

/** Validate a config against the home space: profiles exist, fields allowlisted. */
async function validateConfig(
  database: Db,
  raw: unknown,
  homeWorkspaceId: string,
  settings: unknown
): Promise<SiteConfigV1> {
  const parsed = SiteConfigV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid site configuration: ${parsed.error.message}`);
  }
  const config = parsed.data;
  // A field the public can never see cannot sort or address a collection.
  const fields = new Set(resolvePublicFields(settings, "entity"));
  for (const [key, c] of Object.entries(config.collections)) {
    for (const s of c.sort) {
      const field = s.replace(/^-/, "");
      if (field !== SITE_PUBLISHED_AT_SORT && !fields.has(field)) {
        throw badRequest(
          `Collection "${key}" sorts on "${field}", which this workspace does not publish.`
        );
      }
    }
    if (c.slugField && !fields.has(c.slugField)) {
      throw badRequest(
        `Collection "${key}" addresses records by "${c.slugField}", which this workspace does not publish.`
      );
    }
    // The profile the key names, as seen from the home space (a space's own
    // profile first, then a pod-level one).
    const candidates = await database
      .select({
        workspaceId: profiles.workspaceId,
        profileKind: profiles.profileKind,
        entityScope: profiles.entityScope,
      })
      .from(profiles)
      .where(eq(profiles.slug, key));
    const profile =
      candidates.find((p) => p.workspaceId === homeWorkspaceId) ??
      candidates.find((p) => p.workspaceId === null);
    if (!profile) {
      throw badRequest(`Collection "${key}" names no profile in this space.`);
    }
    // A pod-wide KIND (person, company…) publishes only as a role collection:
    // its records have no workspace whose policy could publish them.
    if (profile.profileKind === "kind" && profile.entityScope === "pod") {
      throw badRequest(
        `Collection "${key}" is a pod-wide kind; publish it through a role (a team or member role in this space) instead.`
      );
    }
  }
  return config;
}

/**
 * Validate + authorize a configure for `userId` (the human it is for). Reads
 * LOADED rows only. Re-run verbatim by the approval executor on the proposal's
 * subject, so a policy tightened while a proposal waited still refuses.
 */
export async function planSite(
  database: Db,
  userId: string,
  req: ConfigureSiteRequest
): Promise<SitePlan> {
  const project = await loadProject(database, req.projectId);
  if (!project) throw notFound("Project");
  const named = req.homeWorkspaceId ?? null;
  if (project.workspaceId && named && named !== project.workspaceId) {
    throw badRequest(
      "A project with a workspace publishes from that workspace; do not name another one."
    );
  }
  const home = project.workspaceId ?? named;
  if (!home) {
    throw badRequest(
      "This project has no workspace: name the home workspace whose policy governs its site (homeWorkspaceId)."
    );
  }
  await assertCanWidenSite(database, userId, project, home);
  const settings = await loadSettings(database, home);
  assertSitePolicy(settings);
  const config = await validateConfig(database, req.config, home, settings);
  // An existing site keeps its home space for life: a different one is a new
  // site (revoke this one first).
  const live = await liveSiteOfProject(database, project.id);
  if (live && live.workspaceId !== home) {
    throw badRequest(
      "This project's site is published from another workspace; revoke it to start a new one."
    );
  }
  return { projectId: project.id, homeWorkspaceId: home, config };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * The site's public metadata, taken NOW from the project: `title` (its name)
 * and `description`, limited to the home space's `kinds.project.public.fields`
 * and re-filtered by the public read's own projector. Empty allowlist = {}.
 */
async function buildSiteMetadata(
  database: Db,
  projectId: string,
  homeWorkspaceId: string
): Promise<Record<string, string | number | boolean>> {
  const fields = resolvePublicFields(
    await loadSettings(database, homeWorkspaceId),
    "project"
  );
  if (fields.length === 0) return {};
  const project = await loadProject(database, projectId);
  if (!project) throw notFound("Project");
  const source: Record<string, unknown> = {
    title: project.name,
    description: project.description ?? undefined,
  };
  const raw: Record<string, unknown> = {};
  for (const key of fields) {
    if (typeof source[key] === "string") raw[key] = source[key];
  }
  return projectPublishedProperties(raw);
}

// ── Configure ────────────────────────────────────────────────────────────────

export type ConfigureSiteResult =
  | { status: "proposed"; proposalId: string }
  | {
      status: "created" | "updated";
      siteId: string;
      state: "draft" | "published";
      /** False for a new site: the owner goes live to mint its token. */
      hasToken: boolean;
      rowsWritten: number;
    };

/** The gate payload an agent's proposal stores: ids and the config, never a token. */
function configureProposalData(plan: SitePlan) {
  return {
    id: randomUUID(),
    op: "configure_site" as const,
    audience: "public" as const,
    resourceType: "project" as const,
    resourceId: plan.projectId,
    projectId: plan.projectId,
    workspaceId: plan.homeWorkspaceId,
    homeWorkspaceId: plan.homeWorkspaceId,
    config: plan.config,
  };
}

/**
 * THE configure door. A human is applied directly; an agent gets ONE proposal
 * (ADMIN floor on `share.create`). The gate carries the site's project.
 */
export async function configureSite(
  actor: ShareActor,
  req: ConfigureSiteRequest & { reasoning?: string }
): Promise<ConfigureSiteResult> {
  const agentUserId = agentOf(actor);
  // ATTRIBUTION FLOOR — same as every share door.
  if (actor.keyType && !agentUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Publishing a site needs a signed-in person or an agent key (run `synap init`); this API key is not attributed to either.",
    });
  }
  const database = await getDb();
  const plan = await planSite(database, actor.userId, req);
  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: agentUserId ?? undefined,
    workspaceId: plan.homeWorkspaceId,
    projectId: plan.projectId,
    subjectType: "share",
    action: "create",
    source: actor.source ?? undefined,
    reasoning: actor.reasoning ?? req.reasoning,
    data: configureProposalData(plan),
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }
  return applyConfigureSite(database, plan, {
    userId: actor.userId,
    agentUserId,
  });
}

/**
 * Write an authorized plan: create the site row (draft, NO token) or replace
 * the live one's config, and re-snapshot its metadata. Never mints a token —
 * only going live does, and only for a signed-in human.
 */
export async function applyConfigureSite(
  database: Db,
  plan: SitePlan,
  opts: {
    userId: string;
    agentUserId?: string | null;
    sourceProposalId?: string;
  }
): Promise<Extract<ConfigureSiteResult, { status: "created" | "updated" }>> {
  const metadata = await buildSiteMetadata(
    database,
    plan.projectId,
    plan.homeWorkspaceId
  );
  const now = new Date();
  const live = await liveSiteOfProject(database, plan.projectId);
  let siteId: string;
  let state: "draft" | "published";
  let hasToken: boolean;
  let rowsWritten: number;
  if (live) {
    const updated = await database
      .update(resourceShares)
      .set({
        siteConfig: plan.config as Record<string, unknown>,
        publishedProperties: metadata,
        updatedAt: now,
      })
      .where(
        and(eq(resourceShares.id, live.id), isNull(resourceShares.revokedAt))
      )
      .returning({ id: resourceShares.id });
    if (updated.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This site was revoked meanwhile; configure it again.",
      });
    }
    siteId = live.id;
    // The row's own state, untouched: configuring never publishes or unpublishes.
    state = live.state as "draft" | "published";
    hasToken = !!live.tokenHash;
    rowsWritten = updated.length;
  } else {
    const [row] = await database
      .insert(resourceShares)
      .values({
        resourceType: "project",
        resourceId: plan.projectId,
        workspaceId: plan.homeWorkspaceId,
        audience: "public",
        anchorProjectId: null,
        state: "draft",
        siteConfig: plan.config as Record<string, unknown>,
        publishedProperties: metadata,
        createdBy: opts.userId,
        permissions: { read: true },
        tokenHash: null,
        tokenPrefix: null,
      })
      .returning({ id: resourceShares.id });
    siteId = row!.id;
    state = "draft";
    hasToken = false;
    rowsWritten = 1;
  }
  auditLog({
    subjectType: "sharing",
    action: live ? "update" : "create",
    phase: "completed",
    subjectId: siteId,
    userId: opts.userId,
    agentUserId: opts.agentUserId ?? undefined,
    proposalId: opts.sourceProposalId,
    workspaceId: plan.homeWorkspaceId,
    // Keys only — never values, never a token.
    data: {
      op: "configure_site",
      siteId,
      projectId: plan.projectId,
      collections: Object.keys(plan.config.collections),
      metadataFields: Object.keys(metadata),
    },
  });
  return {
    status: live ? "updated" : "created",
    siteId,
    state,
    hasToken,
    rowsWritten,
  };
}

// ── Go live / rotate (signed-in human only) ─────────────────────────────────

export interface PublishSiteResult {
  status: "published" | "republished";
  siteId: string;
  /** Plaintext token — present ONCE, when this call minted it. */
  token?: string;
  tokenPrefix: string;
  publishedAt: Date;
  /** The keys the metadata snapshot holds. */
  metadataFields: string[];
}

/** Load a site for a widening act: unrevoked, its project alive, the caller allowed. */
async function loadSiteToWiden(
  database: Db,
  userId: string,
  siteId: string
): Promise<{ site: SiteRow; project: ProjectRow; home: string }> {
  const site = await loadSiteById(database, siteId);
  if (site.revokedAt) {
    throw badRequest(
      "This site was revoked; configure a new site to publish this project again."
    );
  }
  const project = await loadProject(database, site.resourceId);
  if (!project) throw notFound("Project");
  if (!site.workspaceId) throw notFound("Site");
  await assertCanWidenSite(database, userId, project, site.workspaceId);
  return { site, project, home: site.workspaceId };
}

/**
 * GO LIVE: the site is published under its token, with a fresh metadata
 * snapshot. The token is minted the first time only (returned once); a site
 * that was unpublished comes back under the SAME token. Human only.
 */
export async function publishSite(
  actor: ShareActor,
  siteId: string
): Promise<PublishSiteResult> {
  assertHumanSession(actor, "Putting a site on the public web");
  const database = await getDb();
  const { site, project, home } = await loadSiteToWiden(
    database,
    actor.userId,
    siteId
  );
  assertSitePolicy(await loadSettings(database, home));
  const metadata = await buildSiteMetadata(database, project.id, home);
  const minted = site.tokenHash ? undefined : generateShareToken();
  const tokenPrefix = minted ? minted.slice(0, 6) : site.tokenPrefix!;
  const wasLive = isSiteLive({ ...site, hasToken: !!site.tokenHash });
  const now = new Date();
  const updated = await database
    .update(resourceShares)
    .set({
      state: "published",
      publishedAt: now,
      publishedBy: actor.userId,
      publishedProperties: metadata,
      ...(minted ? { tokenHash: hashToken(minted), tokenPrefix } : {}),
      updatedAt: now,
    })
    .where(
      and(eq(resourceShares.id, site.id), isNull(resourceShares.revokedAt))
    )
    .returning({ id: resourceShares.id });
  if (updated.length === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This site was revoked meanwhile.",
    });
  }
  const status = wasLive ? ("republished" as const) : ("published" as const);
  auditLog({
    subjectType: "sharing",
    action: "update",
    phase: "completed",
    subjectId: site.id,
    userId: actor.userId,
    workspaceId: home,
    data: {
      op: "publish_site",
      siteId: site.id,
      projectId: project.id,
      tokenMinted: !!minted,
      metadataFields: Object.keys(metadata),
      outcome: status,
    },
  });
  return {
    status,
    siteId: site.id,
    ...(minted ? { token: minted } : {}),
    tokenPrefix,
    publishedAt: now,
    metadataFields: Object.keys(metadata),
  };
}

/**
 * Replace a site's token: the new one is returned ONCE, the old one answers
 * the uniform 404 from the next request on. Human only. State is unchanged.
 */
export async function rotateSiteToken(
  actor: ShareActor,
  siteId: string
): Promise<{ siteId: string; token: string; tokenPrefix: string }> {
  assertHumanSession(actor, "Minting a site's address");
  const database = await getDb();
  const { site, home } = await loadSiteToWiden(database, actor.userId, siteId);
  const token = generateShareToken();
  const tokenPrefix = token.slice(0, 6);
  const updated = await database
    .update(resourceShares)
    .set({ tokenHash: hashToken(token), tokenPrefix, updatedAt: new Date() })
    .where(
      and(eq(resourceShares.id, site.id), isNull(resourceShares.revokedAt))
    )
    .returning({ id: resourceShares.id });
  if (updated.length === 0) {
    throw badRequest("This site was revoked; configure a new site.");
  }
  auditLog({
    subjectType: "sharing",
    action: "update",
    phase: "completed",
    subjectId: site.id,
    userId: actor.userId,
    workspaceId: home,
    data: { op: "rotate_site_token", siteId: site.id, tokenPrefix },
  });
  return { siteId: site.id, token, tokenPrefix };
}

// ── Unpublish / revoke (narrowing: direct for everyone) ─────────────────────

/** Take the whole site off the web (draft). Keeps its token and its members. */
export async function unpublishSite(
  actor: ShareActor,
  siteId: string
): Promise<{ status: "unpublished" | "none"; siteId: string }> {
  const database = await getDb();
  const site = await loadSiteById(database, siteId);
  await assertCanNarrowSite(
    database,
    actor.userId,
    site,
    await loadProject(database, site.resourceId)
  );
  const updated = await database
    .update(resourceShares)
    .set({ state: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(resourceShares.id, site.id),
        eq(resourceShares.state, "published"),
        isNull(resourceShares.revokedAt)
      )
    )
    .returning({ id: resourceShares.id });
  if (updated.length === 0) return { status: "none", siteId: site.id };
  auditLog({
    subjectType: "sharing",
    action: "update",
    phase: "completed",
    subjectId: site.id,
    userId: actor.userId,
    agentUserId: agentOf(actor) ?? undefined,
    workspaceId: site.workspaceId ?? undefined,
    data: { op: "unpublish_site", siteId: site.id, projectId: site.resourceId },
  });
  return { status: "unpublished", siteId: site.id };
}

/**
 * REVOKE a site, permanently, and every unrevoked member row with it, in ONE
 * transaction. Idempotent: an already-revoked site still sweeps any member
 * left unrevoked, and reports `none` for itself.
 */
export async function revokeSite(
  actor: ShareActor,
  siteId: string
): Promise<{
  status: "revoked" | "none";
  siteId: string;
  membersRevoked: number;
}> {
  const database = await getDb();
  const site = await loadSiteById(database, siteId);
  await assertCanNarrowSite(
    database,
    actor.userId,
    site,
    await loadProject(database, site.resourceId)
  );
  const now = new Date();
  const revoke = {
    revokedAt: now,
    revokedBy: actor.userId,
    state: "draft" as const,
    updatedAt: now,
  };
  const { siteRows, memberRows } = await database.transaction(async (tx) => {
    const siteRows = await tx
      .update(resourceShares)
      .set(revoke)
      .where(
        and(eq(resourceShares.id, site.id), isNull(resourceShares.revokedAt))
      )
      .returning({ id: resourceShares.id });
    const memberRows = await tx
      .update(resourceShares)
      .set(revoke)
      .where(
        and(
          eq(resourceShares.siteShareId, site.id),
          isNull(resourceShares.revokedAt)
        )
      )
      .returning({ id: resourceShares.id });
    return { siteRows, memberRows };
  });
  const status = siteRows.length > 0 ? ("revoked" as const) : ("none" as const);
  if (status === "revoked" || memberRows.length > 0) {
    auditLog({
      subjectType: "sharing",
      action: "delete",
      phase: "completed",
      subjectId: site.id,
      userId: actor.userId,
      agentUserId: agentOf(actor) ?? undefined,
      workspaceId: site.workspaceId ?? undefined,
      data: {
        op: "revoke_site",
        siteId: site.id,
        projectId: site.resourceId,
        revoked: status === "revoked",
        membersRevoked: memberRows.length,
      },
    });
  }
  return { status, siteId: site.id, membersRevoked: memberRows.length };
}

// ── Members: publish records into a site (C1b) ──────────────────────────────

/** A batch publishes at most this many records (one proposal for an agent). */
export const SITE_PUBLISH_MAX_RECORDS = 200;

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A member's public id: `p_` + 16 base62 chars (~95 bits) from the CSPRNG,
 * unbiased (bytes ≥ 248 are rejected). Random, never derived from an id, so
 * it cannot be reversed. Minted once, at the member row's first insert.
 */
export function mintPublicId(): string {
  let out = "p_";
  while (out.length < 18) {
    for (const byte of randomBytes(24)) {
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === 18) break;
    }
  }
  return out;
}

/** 409: the slug is held by another live member of the same collection. */
export class SiteSlugTakenError extends TRPCError {
  readonly holder: { entityId: string; title: string | null };
  constructor(
    slug: string,
    holder: { entityId: string; title: string | null }
  ) {
    super({
      code: "CONFLICT",
      message: `SITE_SLUG_TAKEN: the slug "${slug}" is already used in this collection by record ${holder.entityId}${holder.title ? ` ("${holder.title}")` : ""}. Change the record's slug field or unpublish that record first.`,
    });
    this.holder = holder;
  }
}

/** One record a batch did not publish, and why (the owner's door: ids are fine). */
export interface SiteSkip {
  entityId: string;
  /** `SITE_SLUG_TAKEN`, or the refusal's tRPC code (FORBIDDEN, BAD_REQUEST…). */
  code: string;
  reason: string;
}

function skipOf(entityId: string, err: TRPCError): SiteSkip {
  return {
    entityId,
    code: err instanceof SiteSlugTakenError ? "SITE_SLUG_TAKEN" : err.code,
    reason: err.message,
  };
}

/** One record's validated publish into a site: what the member row will hold. */
export interface SiteMemberPlan {
  entityId: string;
  /** The record's own workspace: its policy allowed it, its switch governs it. */
  workspaceId: string;
  documentId: string | null;
  collection: string;
  snapshot: Record<string, string | number | boolean>;
  slug: string | null;
}

/** A validated, authorized batch — what the gate carries (ids) and approval re-plans. */
export interface SitePublishPlan {
  siteId: string;
  projectId: string;
  homeWorkspaceId: string;
  members: SiteMemberPlan[];
  skipped: SiteSkip[];
}

/** The live member row holding `slug` in a site collection, other than `entityId`. */
async function slugHolder(
  database: Db,
  siteId: string,
  collection: string,
  slug: string,
  entityId: string
): Promise<{ entityId: string; title: string | null } | null> {
  const [row] = await database
    .select({ entityId: resourceShares.resourceId, title: entities.title })
    .from(resourceShares)
    .leftJoin(entities, eq(entities.id, resourceShares.resourceId))
    .where(
      and(
        eq(resourceShares.siteShareId, siteId),
        eq(resourceShares.publishedCollection, collection),
        eq(resourceShares.publicSlug, slug),
        eq(resourceShares.state, "published"),
        isNull(resourceShares.revokedAt),
        ne(resourceShares.resourceId, entityId)
      )
    )
    .limit(1);
  return row ? { entityId: row.entityId, title: row.title ?? null } : null;
}

/**
 * Validate + authorize ONE record's publish into a site, for `userId`. Kind
 * collections only (C1b): the record's profile IS a configured collection,
 * it lives in a workspace the user writes, that workspace's policy publishes
 * entities, and it is filed into the site's project. Takes the snapshot now
 * (the record's workspace's allowlist, the W3 projector) and derives its slug.
 */
async function planSiteMember(
  database: Db,
  userId: string,
  site: { id: string; projectId: string; config: SiteConfigV1 },
  entityId: string,
  settingsOf: (workspaceId: string) => Promise<unknown>
): Promise<SiteMemberPlan> {
  const [record] = await database
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
      ownerId: entities.userId,
      documentId: entities.documentId,
      profileSlug: profiles.slug,
    })
    .from(entities)
    .leftJoin(profiles, eq(profiles.id, entities.profileId))
    .where(and(eq(entities.id, entityId), isNull(entities.deletedAt)))
    .limit(1);
  if (!record) throw notFound("Entity");
  // Authorize on the record BEFORE saying anything else about it.
  await assertWorkspaceWrite(database, userId, {
    workspaceId: record.workspaceId,
    ownerId: record.ownerId,
  });
  if (!record.workspaceId) {
    throw badRequest(
      "A pod-wide record has no workspace policy to publish it under; it can join a site only through a role collection (not available yet)."
    );
  }
  const collection = record.profileSlug;
  const collectionConfig =
    collection && Object.hasOwn(site.config.collections, collection)
      ? site.config.collections[collection]
      : undefined;
  if (!collection || !collectionConfig) {
    throw badRequest(
      `This record's kind${collection ? ` ("${collection}")` : ""} is not a collection of this site; add it to the site's configuration first.`
    );
  }
  const [edge] = await database
    .select({ id: relations.id })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        eq(relations.sourceEntityId, record.id),
        eq(relations.targetEntityId, site.projectId)
      )
    )
    .limit(1);
  if (!edge) {
    throw badRequest(
      "This record is not filed into the site's project; file it there first."
    );
  }
  const settings = await settingsOf(record.workspaceId);
  if (resolveExposurePolicy(settings).entity.public.read !== "direct") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This record's workspace exposure policy does not allow publishing an entity.",
    });
  }
  const snapshot = await buildPublishedSnapshot(database, {
    requestedKind: "entity",
    entityId: record.id,
    workspaceId: record.workspaceId,
    documentId: record.documentId ?? null,
    fields: resolvePublicFields(settings, "entity"),
  });
  const slugField = collectionConfig.slugField;
  const slug = slugField ? slugify(snapshot[slugField]) : null;
  if (slug) {
    const holder = await slugHolder(
      database,
      site.id,
      collection,
      slug,
      record.id
    );
    if (holder) throw new SiteSlugTakenError(slug, holder);
  }
  return {
    entityId: record.id,
    workspaceId: record.workspaceId,
    documentId: record.documentId ?? null,
    collection,
    snapshot,
    slug,
  };
}

/**
 * Validate + authorize a BATCH publish into a site for `userId` (the human it
 * is for). The site-level checks (not revoked, project alive, the user
 * administers the project and writes the home space, the home policy still
 * publishes projects) refuse the whole batch; each record is then planned on
 * its own and a refused one is reported in `skipped` — or, `strict`, thrown
 * (a single-record publish answers like the W3 door: 409, 403…). Re-run
 * verbatim by the approval executor on the proposal's subject.
 */
export async function planSitePublish(
  database: Db,
  userId: string,
  req: { siteId: string; entityIds: readonly string[] },
  opts: { strict?: boolean } = {}
): Promise<SitePublishPlan> {
  const ids = [...new Set(req.entityIds)];
  if (ids.length === 0 || ids.length > SITE_PUBLISH_MAX_RECORDS) {
    throw badRequest(
      `Publish between 1 and ${SITE_PUBLISH_MAX_RECORDS} records at a time.`
    );
  }
  const { site, project, home } = await loadSiteToWiden(
    database,
    userId,
    req.siteId
  );
  assertSitePolicy(await loadSettings(database, home));
  const config = resolveSiteConfig(site.siteConfig);
  const settingsCache = new Map<string, Promise<unknown>>();
  const settingsOf = (workspaceId: string) => {
    let hit = settingsCache.get(workspaceId);
    if (!hit) {
      hit = loadSettings(database, workspaceId);
      settingsCache.set(workspaceId, hit);
    }
    return hit;
  };
  const members: SiteMemberPlan[] = [];
  const skipped: SiteSkip[] = [];
  // Two records of ONE batch may derive the same slug: the first one keeps it.
  const slugsInBatch = new Map<string, string>();
  for (const entityId of ids) {
    try {
      const member = await planSiteMember(
        database,
        userId,
        { id: site.id, projectId: project.id, config },
        entityId,
        settingsOf
      );
      if (member.slug) {
        const key = `${member.collection}\u0000${member.slug}`;
        const first = slugsInBatch.get(key);
        if (first) {
          throw new SiteSlugTakenError(member.slug, {
            entityId: first,
            title: null,
          });
        }
        slugsInBatch.set(key, entityId);
      }
      members.push(member);
    } catch (err) {
      // A refusal is reported; a FAILED read is never folded into one.
      if (!(err instanceof TRPCError) || opts.strict) throw err;
      skipped.push(skipOf(entityId, err));
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

/** The 0336 unique index a racing publish of the same slug hits. */
const SLUG_INDEX = "resource_shares_site_slug_uidx";

/** The constraint a unique violation names, through any wrapping; else null. */
function uniqueViolation(err: unknown): string | null {
  for (
    let e = err as Record<string, unknown> | undefined, i = 0;
    e && i < 4;
    i++
  ) {
    if (e.code === "23505") {
      return typeof e.constraint === "string" ? e.constraint : "";
    }
    e = e.cause as Record<string, unknown> | undefined;
  }
  return null;
}

export interface PublishedMember {
  entityId: string;
  collection: string;
  publicId: string;
  slug: string | null;
  status: "published" | "republished";
}

/**
 * Write an authorized batch. Each record's LIVE member row of this site is
 * re-snapshotted (new snapshot, new pin, slug re-derived, `public_id` kept),
 * or a new member row is inserted with a fresh public id. A slug lost to a
 * racing publish is reported, never thrown, so the rest of the batch lands.
 */
export async function applySitePublish(
  database: Db,
  plan: SitePublishPlan,
  opts: {
    userId: string;
    agentUserId?: string | null;
    sourceProposalId?: string;
  }
): Promise<{
  published: PublishedMember[];
  skipped: SiteSkip[];
  /** Rows the write statements returned. */
  rowsWritten: number;
  ids: string[];
}> {
  const published: PublishedMember[] = [];
  const skipped: SiteSkip[] = [];
  const ids: string[] = [];
  for (const m of plan.members) {
    const pin = await latestCheckpointId(database, m.documentId);
    const now = new Date();
    const [live] = await database
      .select({
        id: resourceShares.id,
        publicId: resourceShares.publicId,
        state: resourceShares.state,
        audience: resourceShares.audience,
        resourceType: resourceShares.resourceType,
        revokedAt: resourceShares.revokedAt,
        expiresAt: resourceShares.expiresAt,
        publishedAt: resourceShares.publishedAt,
        siteShareId: resourceShares.siteShareId,
        pin: resourceShares.publishedDocumentVersionId,
      })
      .from(resourceShares)
      .where(
        and(
          eq(resourceShares.siteShareId, plan.siteId),
          eq(resourceShares.resourceId, m.entityId),
          isNull(resourceShares.revokedAt)
        )
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
            // A live publication never loses its pin (0276 trigger).
            publishedDocumentVersionId: pin ?? live.pin,
            publishedProperties: m.snapshot,
            publishedCollection: m.collection,
            publicSlug: m.slug,
            workspaceId: m.workspaceId,
            updatedAt: now,
          })
          .where(
            and(
              eq(resourceShares.id, live.id),
              isNull(resourceShares.revokedAt)
            )
          )
          .returning({
            id: resourceShares.id,
            publicId: resourceShares.publicId,
          });
      } else {
        [row] = await database
          .insert(resourceShares)
          .values({
            resourceType: "entity",
            resourceId: m.entityId,
            workspaceId: m.workspaceId,
            audience: "public",
            anchorProjectId: null,
            state: "published",
            publishedAt: now,
            publishedBy: opts.userId,
            publishedDocumentVersionId: pin,
            publishedProperties: m.snapshot,
            createdBy: opts.userId,
            permissions: { read: true },
            // A member has no token of its own: the site's token addresses it.
            tokenHash: null,
            tokenPrefix: null,
            siteShareId: plan.siteId,
            publishedCollection: m.collection,
            publicId: mintPublicId(),
            publicSlug: m.slug,
          })
          .returning({
            id: resourceShares.id,
            publicId: resourceShares.publicId,
          });
      }
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === null) throw err;
      skipped.push({
        entityId: m.entityId,
        code: constraint === SLUG_INDEX ? "SITE_SLUG_TAKEN" : "CONFLICT",
        reason:
          constraint === SLUG_INDEX
            ? `SITE_SLUG_TAKEN: the slug "${m.slug}" was taken in this collection meanwhile.`
            : "This record was published into the site concurrently; publish it again.",
      });
      continue;
    }
    if (!row) {
      skipped.push({
        entityId: m.entityId,
        code: "CONFLICT",
        reason:
          "This record's publication was revoked meanwhile; publish again.",
      });
      continue;
    }
    ids.push(row.id);
    published.push({
      entityId: m.entityId,
      collection: m.collection,
      publicId: row.publicId!,
      slug: m.slug,
      status:
        live && isPublicationLive({ ...live, hasToken: false }, { via: "site" })
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
      // Ids and keys only — never values.
      data: {
        op: "publish_records",
        siteId: plan.siteId,
        projectId: plan.projectId,
        entityIds: published.map((p) => p.entityId),
        skipped: [...plan.skipped, ...skipped].map((k) => ({
          entityId: k.entityId,
          code: k.code,
        })),
      },
    });
  }
  return { published, skipped, rowsWritten: ids.length, ids };
}

export type PublishToSiteResult =
  | {
      status: "proposed";
      proposalId: string;
      siteId: string;
      skipped: SiteSkip[];
    }
  | {
      status: "published" | "none";
      siteId: string;
      published: PublishedMember[];
      skipped: SiteSkip[];
      rowsWritten: number;
    };

/**
 * THE batch publish door (D5). A human is applied directly; an agent files ONE
 * proposal for the whole batch (ADMIN floor on `share.create`, `op:
 * "publish_records"`, ids only — never values). The gate carries the site's
 * project, so a project-narrowed key proposes only inside its project; a
 * record from another workspace than the home space is also checked against
 * the key's grant there. A one-record publish that is refused throws (409
 * `SITE_SLUG_TAKEN`, 403…); a batch reports each refused record.
 */
export async function publishToSite(
  actor: ShareActor,
  req: { siteId: string; entityIds: string[]; reasoning?: string }
): Promise<PublishToSiteResult> {
  const agentUserId = agentOf(actor);
  // ATTRIBUTION FLOOR — same as every share door.
  if (actor.keyType && !agentUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Publishing to a site needs a signed-in person or an agent key (run `synap init`); this API key is not attributed to either.",
    });
  }
  const strict = new Set(req.entityIds).size === 1;
  const database = await getDb();
  const plan = await planSitePublish(database, actor.userId, req, { strict });
  if (plan.members.length === 0) {
    return {
      status: "none",
      siteId: plan.siteId,
      published: [],
      skipped: plan.skipped,
      rowsWritten: 0,
    };
  }
  const data = {
    id: randomUUID(),
    op: "publish_records" as const,
    audience: "public" as const,
    resourceType: "entity" as const,
    siteId: plan.siteId,
    entityIds: plan.members.map((m) => m.entityId),
    projectId: plan.projectId,
    workspaceId: plan.homeWorkspaceId,
  };
  // The gate sees the home space; a record of another space must be within
  // the key's grant THERE too (no grant on the request = nothing to check).
  for (const ws of new Set(plan.members.map((m) => m.workspaceId))) {
    if (ws === plan.homeWorkspaceId) continue;
    const denied = await grantWriteDenial({
      subjectType: "share",
      action: "create",
      workspaceId: ws,
      projectId: plan.projectId,
      data,
    });
    if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
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
    data,
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
  const applied = await applySitePublish(database, plan, {
    userId: actor.userId,
    agentUserId,
  });
  if (strict && applied.published.length === 0 && applied.skipped[0]) {
    const [skip] = applied.skipped;
    throw new TRPCError({ code: "CONFLICT", message: skip.reason });
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
 * Take records off ONE site (back to draft: the uniform 404, their public id
 * and slug kept, so publishing again restores the same URL), or — no
 * `entityIds` — the whole site ({@link unpublishSite}). Direct for everyone:
 * it only narrows. Record-level "stop sharing publicly" (`unpublishResource`)
 * is the other door: it takes a record off EVERY site at once.
 */
export async function unpublishFromSite(
  actor: ShareActor,
  req: { siteId: string; entityIds?: string[] | null }
): Promise<{
  status: "unpublished" | "none";
  siteId: string;
  /** The records taken off (record mode only). */
  entityIds?: string[];
}> {
  if (!req.entityIds) return unpublishSite(actor, req.siteId);
  const ids = [...new Set(req.entityIds)];
  if (ids.length === 0 || ids.length > SITE_PUBLISH_MAX_RECORDS) {
    throw badRequest(
      `Unpublish between 1 and ${SITE_PUBLISH_MAX_RECORDS} records at a time.`
    );
  }
  const database = await getDb();
  const site = await loadSiteById(database, req.siteId);
  await assertCanNarrowSite(
    database,
    actor.userId,
    site,
    await loadProject(database, site.resourceId)
  );
  const updated = await database
    .update(resourceShares)
    .set({ state: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(resourceShares.siteShareId, site.id),
        inArray(resourceShares.resourceId, ids),
        eq(resourceShares.state, "published"),
        isNull(resourceShares.revokedAt)
      )
    )
    .returning({ entityId: resourceShares.resourceId });
  const entityIds = updated.map((r) => r.entityId);
  if (entityIds.length > 0) {
    auditLog({
      subjectType: "sharing",
      action: "update",
      phase: "completed",
      subjectId: site.id,
      userId: actor.userId,
      agentUserId: agentOf(actor) ?? undefined,
      workspaceId: site.workspaceId ?? undefined,
      data: {
        op: "unpublish_records",
        siteId: site.id,
        projectId: site.resourceId,
        entityIds,
      },
    });
  }
  return {
    status: entityIds.length > 0 ? "unpublished" : "none",
    siteId: site.id,
    entityIds,
  };
}

// ── Status (owner read) ──────────────────────────────────────────────────────

export interface SiteStatus {
  siteId: string;
  projectId: string;
  homeWorkspaceId: string;
  state: string;
  /** THE one derivation of "the site answers on the public web now". */
  live: boolean;
  hasToken: boolean;
  tokenPrefix: string | null;
  publishedAt: Date | null;
  revokedAt: Date | null;
  /** The stored config as the public doors read it (fail-closed). */
  config: SiteConfigV1;
  /** The metadata snapshot's keys (never its values). */
  metadataFields: string[];
  /** Live members per configured collection (the manifest's own count). */
  collections: Array<{ key: string; count: number }>;
  /**
   * The site's member rows that are not revoked (published or taken back to
   * draft), newest publish first, at most {@link SITE_STATUS_MEMBER_CAP}.
   */
  members: SiteStatusMember[];
  /** More member rows exist than `members` lists. */
  membersTruncated: boolean;
}

/** One record of a site, as its owner sees it (internal ids are fine here). */
export interface SiteStatusMember {
  entityId: string;
  /** The record's CURRENT title (owner side; the public sees the snapshot). */
  title: string | null;
  collection: string | null;
  publicId: string | null;
  slug: string | null;
  state: string;
  publishedAt: Date | null;
  /** Served on the public web right now: the site is live AND the member passes every narrowing check. */
  live: boolean;
  /** The record changed after its snapshot: publish it again to refresh it. */
  stale: boolean;
}

export const SITE_STATUS_MEMBER_CAP = 500;

async function statusMembers(
  database: Db,
  site: { id: string; projectId: string },
  siteLive: boolean
): Promise<{ members: SiteStatusMember[]; truncated: boolean }> {
  const rows = await database
    .select({
      id: resourceShares.id,
      entityId: resourceShares.resourceId,
      title: entities.title,
      entityUpdatedAt: entities.updatedAt,
      collection: resourceShares.publishedCollection,
      publicId: resourceShares.publicId,
      slug: resourceShares.publicSlug,
      state: resourceShares.state,
      publishedAt: resourceShares.publishedAt,
    })
    .from(resourceShares)
    .leftJoin(entities, eq(entities.id, resourceShares.resourceId))
    .where(
      and(
        eq(resourceShares.siteShareId, site.id),
        isNull(resourceShares.revokedAt)
      )
    )
    .orderBy(desc(resourceShares.publishedAt), asc(resourceShares.id))
    .limit(SITE_STATUS_MEMBER_CAP + 1);
  const listed = rows.slice(0, SITE_STATUS_MEMBER_CAP);
  // THE public rule, not a re-derivation: the same predicate the doors serve.
  const liveIds = new Set<string>();
  if (siteLive && listed.length > 0) {
    const open = await openMemberWorkspaces(site.id);
    const served = await database
      .select({ id: resourceShares.id })
      .from(resourceShares)
      .where(
        and(
          liveMemberWhere(site, open),
          inArray(
            resourceShares.id,
            listed.map((r) => r.id)
          )
        )
      );
    for (const { id } of served) liveIds.add(id);
  }
  return {
    members: listed.map((r) => ({
      entityId: r.entityId,
      title: r.title ?? null,
      collection: r.collection,
      publicId: r.publicId,
      slug: r.slug,
      state: r.state,
      publishedAt: r.publishedAt,
      live: liveIds.has(r.id),
      stale:
        !!r.publishedAt &&
        !!r.entityUpdatedAt &&
        r.entityUpdatedAt.getTime() > r.publishedAt.getTime(),
    })),
    truncated: rows.length > SITE_STATUS_MEMBER_CAP,
  };
}

/**
 * A site's owner-side status, by site id or by project (its live site; null
 * when it has none). Never a token or its hash.
 */
export async function siteStatus(
  actor: ShareActor,
  req: { siteId: string } | { projectId: string }
): Promise<SiteStatus | null> {
  const database = await getDb();
  let site: SiteRow;
  let project: ProjectRow | null;
  if ("siteId" in req) {
    site = await loadSiteById(database, req.siteId);
    project = await loadProject(database, site.resourceId);
  } else {
    project = await loadProject(database, req.projectId);
    if (!project) throw notFound("Project");
    const live = await liveSiteOfProject(database, project.id);
    if (!live) {
      // Same authz as a status read of an existing site, on the project's
      // own workspace (a pod-wide project: its owner).
      if (project.workspaceId) {
        await assertCanNarrow(
          database,
          actor.userId,
          {
            kind: "project",
            id: project.id,
            workspaceId: project.workspaceId,
            ownerId: project.userId,
          },
          {
            id: project.id,
            workspaceId: project.workspaceId,
            userId: project.userId,
          }
        );
      } else if (project.userId !== actor.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the project's owner can see its site.",
        });
      }
      return null;
    }
    site = live;
  }
  await assertCanNarrowSite(database, actor.userId, site, project);
  const config = resolveSiteConfig(site.siteConfig);
  const ref = { id: site.id, projectId: site.resourceId };
  const counts = await liveMemberCounts(ref, Object.keys(config.collections));
  const live = isSiteLive({ ...site, hasToken: !!site.tokenHash });
  const { members, truncated } = await statusMembers(database, ref, live);
  return {
    siteId: site.id,
    projectId: site.resourceId,
    homeWorkspaceId: site.workspaceId!,
    state: site.state,
    live,
    hasToken: !!site.tokenHash,
    tokenPrefix: site.tokenPrefix,
    publishedAt: site.publishedAt,
    revokedAt: site.revokedAt,
    config,
    metadataFields:
      site.publishedProperties &&
      typeof site.publishedProperties === "object" &&
      !Array.isArray(site.publishedProperties)
        ? Object.keys(site.publishedProperties)
        : [],
    collections: Object.keys(config.collections).map((key) => ({
      key,
      count: counts.get(key) ?? 0,
    })),
    members,
    membersTruncated: truncated,
  };
}
