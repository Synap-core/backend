/**
 * Renderers — what a host with no renderers of its own (pod admin) reads to
 * draw pod content through the installed renderer bundle (spec c9b1e4d0 §3c).
 *
 *   status       the active bundle (or null), its defaults (by cell key; the
 *                cell is `cell:<slug>:<key>`) and the frame / iframe cells the
 *                caller may read, without their source
 *   hostModules  the bundle's host-module set, or `notModified` when the
 *                caller already holds `knownSetSha256`; NOT_FOUND
 *                (`reasonCode: NO_RENDERER_BUNDLE`) when none is installed
 *
 * A cell's source stays on `widgetDefinitions.get`. The Hub REST mirror of
 * `hostModules` is `GET /api/hub/renderers/host-modules` (ETag / 304).
 * Installing is `market.install` kind `renderer-bundle`.
 */

import { z } from "zod";
import { router, podProcedure } from "../trpc.js";
import {
  readRendererHostModules,
  readRendererStatus,
} from "../services/renderers/read-renderer-bundle.js";

export const renderersRouter = router({
  status: podProcedure.query(({ ctx }) =>
    readRendererStatus({ workspaceId: ctx.workspaceId ?? null })
  ),

  hostModules: podProcedure
    .input(
      z
        .object({
          knownSetSha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
        .optional()
    )
    .query(({ input }) =>
      readRendererHostModules({ knownSetSha256: input?.knownSetSha256 })
    ),
});
