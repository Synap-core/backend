/**
 * Hub REST — `POST /workspaces/ensure-template` (TEMPLATE-LIFECYCLE Contract B).
 *
 * The Hub mirror of tRPC `workspaces.ensureTemplate`. A TRANSPORT only: it
 * calls the tRPC procedure with a Hub caller context carrying the acting agent,
 * so the standing read, the governance gate and the install are the
 * procedure's — never a second implementation. An agent or app key's install
 * comes back `proposed` (202, with its review link), a person's installs.
 *
 * Its own file (not `workspaces.ts`) and registered BEFORE
 * `registerWorkspacesRoutes`, so the static path always wins over any
 * `/workspaces/:id` pattern.
 */

import { z } from "zod";
import { type HubHono, hasScope, httpStatusForTrpcError } from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { workspaceCatalogRouter } from "../../workspaces.js";

const EnsureTemplateBodySchema = z.object({
  slug: z.string().min(1),
  install: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

export function registerWorkspacesEnsureTemplateRoutes(app: HubHono): void {
  app.post("/workspaces/ensure-template", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = EnsureTemplateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    // `install: true` creates a workspace (a write); without it the door only
    // reports whether the template is installed (a read). Neither checked a
    // scope before.
    const needed = parsed.data.install
      ? "hub-protocol.write"
      : "hub-protocol.read";
    if (!hasScope(c.get("scopes") ?? [], needed)) {
      return c.json({ error: `Missing scope: ${needed}` }, 403);
    }

    const ctx = await createHubProtocolCallerContext(
      c.get("userId"),
      c.get("scopes") ?? [],
      null,
      null,
      c.get("sessionId") ?? null,
      c.get("agentUserId") ?? null,
      c.get("keyType") ?? null,
      c.get("keyWorkspaceId") ?? null
    );
    try {
      const result = await workspaceCatalogRouter
        .createCaller(ctx as never)
        .ensureTemplate(parsed.data);
      return jsonGoverned(c, result);
    } catch (err) {
      // Duck-typed (tripwire `no-instanceof-trpcerror-in-rest`): a gate denial
      // is a 403, an unknown failure a 500 — never a calm standing.
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
