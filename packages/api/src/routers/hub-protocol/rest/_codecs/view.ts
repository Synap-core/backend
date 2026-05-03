/**
 * View Wire Codecs — Hub Protocol REST schemas for views (kanban, table, bento, etc.).
 *
 * Views are named queries + rendering configs over the entity store. Same data,
 * different lens. The bento view type also stores a widget arrangement that the
 * /views/{viewId}/arrange endpoint mutates.
 */

import { z } from "@hono/zod-openapi";

/** Canonical wire shape for a view row. */
export const WireViewSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    workspaceId: z.string().nullable().optional(),
    name: z.string(),
    type: z.string(),
    profileId: z.string().nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("View");

/** GET /views query. */
export const ListViewsQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string().optional(),
    type: z
      .string()
      .optional()
      .describe("Filter by view type (table, kanban, ...)."),
    profileId: z
      .string()
      .optional()
      .describe("Filter to views over a specific profile."),
  })
  .openapi("ListViewsQuery");

/** POST /views request body. */
export const CreateViewRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string().nullable().optional(),
    name: z.string(),
    type: z
      .string()
      .describe(
        "View type — table, list, grid, gallery, kanban, matrix, masonry, calendar, flow, bento, branch_tree, whiteboard."
      ),
    profileId: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    agentUserId: z.string().optional(),
    reasoning: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("CreateViewRequest");

/** PATCH /views/{viewId} request body. */
export const UpdateViewRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string().optional(),
    name: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    agentUserId: z.string().optional(),
    reasoning: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("UpdateViewRequest");

/** Bento widget layout entry (row in the react-grid-layout). */
export const BentoWidgetSchema = z
  .object({
    id: z.string(),
    kind: z.string().describe("Cell kind — view | entity | widget | <custom>."),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .openapi("BentoWidget");

/** POST /views/{viewId}/arrange request body. */
export const ArrangeViewRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string().optional(),
    widgets: z
      .array(BentoWidgetSchema)
      .describe("Replacement widget arrangement for a bento view."),
    agentUserId: z.string().optional(),
    reasoning: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("ArrangeViewRequest");
