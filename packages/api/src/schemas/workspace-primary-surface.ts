import { z } from "zod";
import type {
  WorkspaceJsonValue,
  WorkspacePrimarySurfaceDefinition,
} from "@synap/database";

const workspaceJsonValueSchema: z.ZodType<WorkspaceJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(workspaceJsonValueSchema),
    z.record(z.string(), workspaceJsonValueSchema),
  ])
);

/**
 * One inbound validator for package/template primary surfaces. A view may use
 * its persisted ID or an authoring-time name/slug; the database layer resolves
 * the latter after view creation. It is shared by tRPC and Hub REST so the two
 * install doors cannot drift.
 */
export const workspacePrimarySurfaceSchema: z.ZodType<WorkspacePrimarySurfaceDefinition> =
  z.union([
    z
      .object({
        kind: z.literal("app"),
        appId: z.string().min(1),
        rendererType: z.literal("native"),
        title: z.string().optional(),
        props: z.record(z.string(), workspaceJsonValueSchema).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("app"),
        appId: z.string().min(1),
        rendererType: z.literal("external"),
        url: z.string().url(),
        title: z.string().optional(),
        props: z.record(z.string(), workspaceJsonValueSchema).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("cell"),
        cellKey: z.string().min(1),
        title: z.string().optional(),
        props: z.record(z.string(), workspaceJsonValueSchema).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("view"),
        viewId: z.string().min(1),
        title: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("view"),
        viewName: z.string().min(1),
        viewSlug: z.string().min(1).optional(),
        title: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("view"),
        viewName: z.string().min(1).optional(),
        viewSlug: z.string().min(1),
        title: z.string().optional(),
      })
      .strict(),
  ]);
