/**
 * Site status — Hub Protocol REST schemas for the OWNER read of a project's
 * site (`siteStatus`, services/sharing/site-service.ts): GET /shares/sites
 * (by project) and GET /shares/sites/{id}. Mirrors `SiteStatus` and
 * `SiteStatusMember`; never a token or its hash.
 */

import { z } from "@hono/zod-openapi";

const SiteCollectionConfigSchema = z.object({
  sort: z.array(z.string()),
  pageSize: z.number().int(),
  slugField: z.string().nullable(),
  publishWhen: z.object({ statuses: z.array(z.string()) }).nullable(),
});

const SiteStatusMemberSchema = z.object({
  entityId: z.string(),
  title: z.string().nullable().describe("The record's current title."),
  collection: z.string().nullable(),
  publicId: z.string().nullable(),
  slug: z.string().nullable(),
  state: z.string(),
  publishedAt: z.string().nullable(),
  live: z.boolean().describe("Served on the public web right now."),
  stale: z
    .boolean()
    .describe("The record changed after its snapshot: publish it again."),
});

/** One site as its owner sees it, with one page of its members. */
export const SiteStatusSchema = z
  .object({
    siteId: z.string(),
    projectId: z.string(),
    homeWorkspaceId: z.string(),
    state: z.string(),
    live: z.boolean(),
    hasToken: z.boolean(),
    tokenPrefix: z.string().nullable(),
    publishedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    config: z.object({
      version: z.literal(1),
      collections: z.record(z.string(), SiteCollectionConfigSchema),
    }),
    metadataFields: z.array(z.string()),
    collections: z.array(z.object({ key: z.string(), count: z.number() })),
    members: z.array(SiteStatusMemberSchema),
    membersNextCursor: z.string().nullable(),
    membersTotal: z.number().int(),
  })
  .openapi("SiteStatus");

/** GET /shares/sites: the project's live site, or null when it has none. */
export const SiteStatusOrNoneSchema = SiteStatusSchema.nullable();

const MembersPage = {
  cursor: z.string().max(512).optional(),
  limit: z.string().optional().describe("Members per page (clamped)."),
};

/** GET /shares/sites query: the project, and one page of the members. */
export const SiteStatusByProjectQuerySchema = z.object({
  projectId: z.string().uuid(),
  ...MembersPage,
});

/** GET /shares/sites/{id}: the site (its share row id), one page of members. */
export const SiteStatusParamsSchema = z.object({
  id: z.string().uuid().describe("The site (its share row id)."),
});
export const SiteStatusPageQuerySchema = z.object(MembersPage);
