/**
 * Site charts — Hub Protocol REST schemas for the OWNER doors that publish
 * charts into a site and take them off (`services/sharing/site-charts.ts`).
 * The public read doors' schemas live in `public-sites.ts`.
 */

import { z } from "@hono/zod-openapi";

const MAX = 200;
/** Mirrors `CHART_MODES` (services/sharing/site-charts.ts). */
const CHART_MODES = ["snapshot", "live"] as const;

/** POST /shares/sites/{id}/charts/publish body. */
export const PublishChartsBodySchema = z
  .object({
    charts: z
      .array(
        z.object({
          cellInstanceId: z
            .string()
            .uuid()
            .describe("The chart (a cell instance)."),
          mode: z
            .enum(CHART_MODES)
            .describe(
              "snapshot: data frozen now; live: re-read on each public read (pod chart keys only).",
            ),
          slug: z
            .string()
            .max(96)
            .nullable()
            .optional()
            .describe(
              "The URL slug; default the cell's name. null = public id only.",
            ),
        }),
      )
      .min(1)
      .max(MAX),
    reasoning: z.string().max(2000).optional(),
  })
  .openapi("PublishChartsBody");

const ChartSkipSchema = z.object({
  cellInstanceId: z.string(),
  code: z.string(),
  reason: z.string(),
});

/** What a chart publish answers: applied (a person) or proposed (an agent, 202). */
export const PublishChartsResultSchema = z
  .object({
    status: z.enum(["published", "none", "proposed"]),
    siteId: z.string(),
    proposalId: z.string().optional(),
    published: z
      .array(
        z.object({
          cellInstanceId: z.string(),
          publicId: z.string(),
          slug: z.string().nullable(),
          mode: z.enum(CHART_MODES),
          status: z.enum(["published", "republished"]),
        }),
      )
      .optional(),
    skipped: z.array(ChartSkipSchema),
    rowsWritten: z.number().int().optional(),
  })
  .openapi("PublishChartsResult");

/** POST /shares/sites/{id}/charts/unpublish body. */
export const UnpublishChartsBodySchema = z
  .object({ cellInstanceIds: z.array(z.string().uuid()).min(1).max(MAX) })
  .openapi("UnpublishChartsBody");

export const UnpublishChartsResultSchema = z
  .object({
    status: z.enum(["unpublished", "none"]),
    count: z.number().int(),
  })
  .openapi("UnpublishChartsResult");

/** The site id in the path. */
export const SiteIdParamsSchema = z
  .object({ id: z.string().uuid().describe("The site (its share row id).") })
  .openapi("SiteChartsSiteParams");
