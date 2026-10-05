/**
 * Hub Protocol REST — brand kit (Content × Brand C2).
 *
 * GET /brand/kit?format=json|css|frame-md[&projectId][&workspaceId]
 *
 * The ONE door every agent, the CLI and the IS use to read the caller's brand:
 * it resolves the brand workspace (project → workspace → pod default, see
 * `services/brand/brand-kit-service.ts`) and returns the kit rendered by the
 * shared `@synap-core/types/brand-kit` module.
 *
 *   200 `{ format, content, hash, brandWorkspaceId, resolvedVia }`
 *   404 `{ error, reason: "no_brand_workspace" | "project_not_found" }` — a
 *       TYPED absence; a caller may render "no brand".
 *   5xx on a failed read — never an empty kit.
 */

import { z } from "@hono/zod-openapi";
import { BRAND_KIT_FORMATS } from "@synap-core/types/brand-kit";

import {
  readBrandKit,
  resolveBrandWorkspace,
} from "../../../services/brand/brand-kit-service.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const BrandKitQuerySchema = z.object({
  format: z
    .enum(BRAND_KIT_FORMATS as [string, ...string[]])
    .default("json")
    .transform((f) => f as (typeof BRAND_KIT_FORMATS)[number]),
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
});

const BrandKitResponseSchema = z.object({
  format: z.enum(BRAND_KIT_FORMATS as [string, ...string[]]),
  content: z.string(),
  hash: z.string(),
  brandWorkspaceId: z.string(),
  resolvedVia: z.enum(["project", "workspace", "pod-default"]),
});

const BrandKitNotFoundSchema = z.object({
  error: z.string(),
  reason: z.enum(["no_brand_workspace", "project_not_found"]),
});

export function registerBrandRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/brand/kit",
    tags: ["Brand"],
    summary: "The caller's brand kit (json, css or frame-md)",
    description:
      "Resolves the brand workspace — the project's used Brand Library, else " +
      "the given workspace (or the brand source it declares), else the pod's " +
      "brand provider — and returns the kit with a deterministic content " +
      "`hash`. 404 with a typed `reason` when there is no brand; a failed " +
      "read is a 5xx, never an empty kit.",
    request: { query: BrandKitQuerySchema },
    responses: {
      200: { description: "The kit", schema: BrandKitResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No brand", schema: BrandKitNotFoundSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/brand/kit", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const parsed = BrandKitQuerySchema.safeParse({
      format: c.req.query("format") || undefined,
      projectId: c.req.query("projectId") || undefined,
      workspaceId: c.req.query("workspaceId") || undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }
    // Identity only: the workspace is NOT membership-checked here — a Brand
    // Library is commonly pod-visible without membership. The resolver floors
    // every workspace with `userVisibleWhere` instead.
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const { format, projectId, workspaceId } = parsed.data;
    try {
      const resolution = await resolveBrandWorkspace({
        userId: acting.userId,
        projectId,
        workspaceId,
      });
      if (!resolution.ok) {
        return c.json(
          {
            error:
              resolution.reason === "project_not_found"
                ? "Project not found"
                : "No brand library is available to this caller",
            reason: resolution.reason,
          },
          404
        );
      }
      const kit = await readBrandKit({
        userId: acting.userId,
        brandWorkspaceId: resolution.brandWorkspaceId,
        format,
      });
      return c.json({
        ...kit,
        brandWorkspaceId: resolution.brandWorkspaceId,
        resolvedVia: resolution.resolvedVia,
      });
    } catch (err) {
      logger.error({ err }, "brand.kit failed");
      const status = httpStatusForTrpcError(err);
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        // A failed read must never look like a typed absence.
        status === 404 ? 500 : status
      );
    }
  });
}
