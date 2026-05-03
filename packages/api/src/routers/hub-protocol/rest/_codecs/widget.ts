/**
 * Widget Definition Wire Codecs — registry of cell/widget definitions.
 */

import { z } from "@hono/zod-openapi";

/** Wire shape of a widget definition row. */
export const WireWidgetDefSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable().optional(),
    kind: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("WidgetDefinition");

/** GET /widget-definitions query. */
export const ListWidgetDefsQuerySchema = z
  .object({
    workspaceId: z.string().optional(),
  })
  .openapi("ListWidgetDefsQuery");

/**
 * POST /widget-definitions request body.
 * The exact shape is determined by the widget kind — passthrough so callers can
 * supply additional kind-specific fields.
 */
export const UpsertWidgetDefRequestSchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    kind: z.string(),
    name: z.string().optional(),
    category: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    sourceMessageId: z.string().optional(),
  })
  .passthrough()
  .openapi("UpsertWidgetDefRequest");
