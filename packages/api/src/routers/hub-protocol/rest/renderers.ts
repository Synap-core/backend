/**
 * Hub Protocol REST — renderers: the REST mirror of `renderers.hostModules`
 * (spec c9b1e4d0 §3c), for a host that caches the bundle's host modules over
 * HTTP.
 *
 *   GET /renderers/host-modules
 *     200 { setSha256, modules: { <module>: <source> }, kitExports }
 *         ETag: "sha256:<setSha256>", Cache-Control: private, no-cache
 *     304 when If-None-Match names that ETag (same headers, no body)
 *     404 { error, code: "NO_RENDERER_BUNDLE" } when none is installed
 *
 * The modules are the bundle's build output (React, the kit, the tokens),
 * the same for every caller: `hub-protocol.read` is the scope, and the door
 * fence refuses it to every scoped key (`GRANT_REST_GET_READS`, REFUSED: the
 * licensed kit goes only to a full key's host).
 *
 * The 200's ETag and body come from ONE read (`readRendererHostModules`), so
 * a host never caches modules under another set's tag.
 */

import { z } from "zod";
import type { Context } from "hono";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
} from "./_shared.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  NO_RENDERER_BUNDLE,
  readRendererHostModules,
  readRendererSetSha256,
} from "../../../services/renderers/read-renderer-bundle.js";
import { ifNoneMatchHits } from "../../../services/sharing/public-read.js";

const HostModulesSchema = z.object({
  setSha256: z.string(),
  modules: z.record(z.string(), z.string()),
  kitExports: z.array(z.string()),
});

/** The ETag of a host-module set. */
export function hostModulesEtag(setSha256: string): string {
  return `"sha256:${setSha256}"`;
}

function noBundle(c: Context) {
  return c.json(
    {
      error: "No renderer bundle is installed on this pod.",
      code: NO_RENDERER_BUNDLE,
    },
    404
  );
}

export function registerRenderersRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/renderers/host-modules",
    tags: ["Renderers"],
    summary: "Read the installed renderer bundle's host modules",
    description:
      'The host-module set (React, react-dom, the JSX runtimes, the kit, the tokens CSS) of the renderer bundle installed on this pod, with `ETag: "sha256:<setSha256>"`. Send it back as `If-None-Match` to get 304 while the set is unchanged.',
    responses: {
      200: { description: "The host modules", schema: HostModulesSchema },
      304: { description: "The set the caller holds is current" },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No renderer bundle installed", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/renderers/host-modules", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    try {
      // The set's identity first: a 304 never reads the modules.
      const current = await readRendererSetSha256();
      if (!current) return noBundle(c);
      const cacheHeaders = (setSha256: string) => ({
        ETag: hostModulesEtag(setSha256),
        "Cache-Control": "private, no-cache",
      });
      if (
        ifNoneMatchHits(c.req.header("If-None-Match"), hostModulesEtag(current))
      ) {
        return c.body(null, 304, cacheHeaders(current));
      }
      const read = await readRendererHostModules({});
      // `notModified` needs a known set, and none was sent.
      if (read.notModified)
        return c.body(null, 304, cacheHeaders(read.setSha256));
      return c.json(
        {
          setSha256: read.setSha256,
          modules: read.modules,
          kitExports: read.kitExports,
        },
        200,
        cacheHeaders(read.setSha256)
      );
    } catch (err) {
      const reason = (err as { cause?: { reasonCode?: unknown } }).cause
        ?.reasonCode;
      if (reason === NO_RENDERER_BUNDLE) return noBundle(c);
      logger.error({ err }, "renderers.hostModules failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
