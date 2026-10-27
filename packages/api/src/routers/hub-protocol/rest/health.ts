/**
 * Hub Protocol REST — health
 *
 * Public, no-auth health endpoint. The auth middleware in hub-protocol-rest.ts
 * skip-lists "/health" so this works without credentials.
 */

import { z } from "@hono/zod-openapi";

import { schemaHashOfFile } from "../../../../scripts/schema-hash.mjs";
import { registerOpenApi } from "./_codecs/_register.js";
import type { HubHono } from "./_shared.js";

// Injected by tsup.config.ts from the committed generated.d.ts, so the shipped
// bundle needs no file at runtime. Absent under tsx/vitest, which run from the
// monorepo where the file is read instead.
declare const __API_TYPES_SCHEMA_HASH__: string | undefined;

let schemaHash: string | undefined;

/** The hash of the api-types contract this pod serves. Throws if unreadable. */
export function apiTypesSchemaHash(): string {
  schemaHash ??=
    typeof __API_TYPES_SCHEMA_HASH__ === "string"
      ? __API_TYPES_SCHEMA_HASH__
      : schemaHashOfFile();
  return schemaHash;
}

export function registerHealthRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Liveness probe",
    description: "Public, no-auth health endpoint.",
    security: [],
    responses: {
      200: {
        description: "OK",
        schema: z.object({
          status: z.string(),
          service: z.string(),
          schemaHash: z.string(),
        }),
      },
    },
  });

  /**
   * GET /health (no auth)
   */
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "hub-protocol",
      schemaHash: apiTypesSchemaHash(),
    })
  );
}
