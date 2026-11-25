/**
 * Can this start page open in this space? Checked by `workspaces.setPrimarySurface`
 * (the ONE door that writes `settings.layout.primarySurface` at runtime; the MCP
 * `synap_set_start_page` and every other caller go through it) BEFORE its gate,
 * so a start page that would open blank is refused in the caller's own reply,
 * never filed as a proposal.
 *
 * Only what the shape cannot say is checked here; the shape itself (an http(s)
 * URL, a pod-app client id, …) is `workspaceRuntimePrimarySurfaceSchema`'s job.
 *
 *   - `cell` — its `cellKey` must be in the renderables catalog this space sees
 *     (`listRenderables`: every built-in, plus the active pod-wide and this
 *     space's installed / AI-made cells), the same catalog `synap_list_widgets`
 *     lists and the bento arrange gate reads.
 *   - every other kind passes: a url is any site, an app is resolved by the
 *     host, and a view's id is NOT checked here (a known gap: no agent door
 *     sets a view start page today).
 *   - `null` (back to the space's home) always passes.
 */
import { TRPCError } from "@trpc/server";
import type { WorkspacePrimarySurface } from "@synap/database";
import { listRenderables } from "./cells/renderables.js";

export async function assertPrimarySurfaceOpens(
  workspaceId: string,
  surface: WorkspacePrimarySurface | null
): Promise<void> {
  if (!surface || surface.kind !== "cell") return;
  const rows = await listRenderables(workspaceId);
  if (rows.some((row) => row.typeKey === surface.cellKey)) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `No cell "${surface.cellKey}" can open in this space. Use a key that ` +
      `synap_list_widgets lists for this workspace (GET /api/hub/widget-definitions?workspaceId=…); ` +
      `a cell made with synap_create_cell is listed once its proposal is approved.`,
  });
}
