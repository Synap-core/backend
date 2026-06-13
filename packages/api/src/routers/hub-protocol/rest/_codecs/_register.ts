/**
 * Helper for registering an OpenAPI route definition without rewriting the
 * underlying Hono handler. The `OpenAPIHono` super-class exposes
 * `openAPIRegistry.registerPath(...)` which is exactly what we need here:
 *
 *   - Keeps the existing `app.get(...)` / `app.post(...)` handlers as-is.
 *   - Just registers metadata that surfaces in `/openapi.json`.
 *
 * Trade-off: route configs are not type-checked against the handler signature
 * (the `app.openapi(routeDef, handler)` flow does that). For incremental
 * migration this is the right level of pragmatism — the spec doc is a source
 * of truth for clients, the handler stays the source of truth for behavior.
 */

import type { HubHono } from "../_shared.js";
import type { ZodType } from "zod";

type Method = "get" | "post" | "put" | "patch" | "delete";

/**
 * Minimal stub: registers a route in the OpenAPI doc with `path`, `method`,
 * `tags`, `summary` and a generic 200 response. Used when full schema design
 * isn't worth the overhead but the path should still be discoverable in the
 * spec.
 */
export function registerStub(
  app: HubHono,
  config: {
    method: Method;
    path: string;
    tags: string[];
    summary: string;
    description?: string;
    /** Default true. Set false for unauth/setup endpoints. */
    secured?: boolean;
  }
): void {
  app.openAPIRegistry.registerPath({
    method: config.method,
    path: config.path,
    tags: config.tags,
    summary: config.summary,
    description: config.description,
    security: config.secured === false ? [] : [{ bearerAuth: [] }],
    responses: {
      "200": { description: "Success" },
      "401": { description: "Unauthorized" },
      "403": { description: "Forbidden — missing scope" },
      "500": { description: "Internal error" },
    },
  } as never);
}

interface RegisterRouteConfig {
  method: Method;
  path: string;
  tags?: string[];
  summary?: string;
  description?: string;
  /** Reference name for $ref (optional). */
  operationId?: string;
  /** Marks the route deprecated in the OpenAPI spec (still functional). */
  deprecated?: boolean;
  /** Whether the route is publicly accessible. Defaults to bearerAuth. */
  security?: Array<Record<string, string[]>>;
  /** Request shape — body / params / query / headers. */
  request?: {
    body?: ZodType;
    params?: ZodType;
    query?: ZodType;
    headers?: ZodType;
  };
  /** Map of status code → response. Each value is `{ description, schema? }`. */
  responses: Record<number | string, { description: string; schema?: ZodType }>;
}

/**
 * Register an OpenAPI route on the hub app.
 *
 * Side effect: mutates `app.openAPIRegistry`. The actual request handler must
 * be registered separately via `app.get`/`app.post`/etc.
 */
export function registerOpenApi(
  app: HubHono,
  config: RegisterRouteConfig
): void {
  const responses: Record<string, unknown> = {};
  for (const [code, resp] of Object.entries(config.responses)) {
    if (resp.schema) {
      responses[code] = {
        description: resp.description,
        content: {
          "application/json": {
            schema: resp.schema,
          },
        },
      };
    } else {
      responses[code] = { description: resp.description };
    }
  }

  const request: Record<string, unknown> = {};
  if (config.request?.body) {
    request.body = {
      content: {
        "application/json": {
          schema: config.request.body,
        },
      },
    };
  }
  if (config.request?.params) request.params = config.request.params;
  if (config.request?.query) request.query = config.request.query;
  if (config.request?.headers) request.headers = config.request.headers;

  app.openAPIRegistry.registerPath({
    method: config.method,
    path: config.path,
    tags: config.tags,
    summary: config.summary,
    description: config.description,
    operationId: config.operationId,
    deprecated: config.deprecated,
    security: config.security ?? [{ bearerAuth: [] }],
    request: Object.keys(request).length > 0 ? request : undefined,
    responses: responses as never,
  } as never);
}
