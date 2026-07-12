/**
 * Hub Protocol REST — GET /briefs
 *
 * AI Teaching Substrate Wave 2b, part 2: the IS/external-consumer door onto
 * `composeCapabilityBrief` (`services/capability-briefs/compose-capability-brief.ts`).
 * The MCP door (`routers/mcp/tools/index.ts`) calls the SAME composer in-process;
 * this route exists for callers that aren't MCP (the IS runtime-context section,
 * Wave 3) and for debugging. One door, one composer — never re-derive the
 * teaching/governance/posture assembly here.
 *
 * Read-only (hub-protocol.read) — briefs are advisory text, not a write.
 *
 * Routes:
 *   GET /briefs?tools=synap_create_document,synap_create_entity&workspaceId=<uuid>&door=chat
 *     → { briefs: Record<toolName, string> } — omits entries with no brief content.
 */

import { z } from "@hono/zod-openapi";
import { and, eq, getDb, workspaceMembers } from "@synap/database";

import { composeCapabilityBrief } from "../../../services/capability-briefs/compose-capability-brief.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, type HubHono } from "./_shared.js";

const BriefsQuerySchema = z.object({
  tools: z.string().min(1),
  workspaceId: z.string().uuid().optional(),
  door: z.enum(["chat", "automation"]).optional(),
});

const BriefsResponseSchema = z.object({
  briefs: z.record(z.string(), z.string()),
});

export function registerBriefsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/briefs",
    tags: ["Skills"],
    summary: "Composed just-in-time teaching briefs for a set of tool names",
    description:
      "Returns a composed teaching brief per requested tool name — teaching core " +
      "(seeded system skills), a live governance verdict (auto/propose), and " +
      "per-kind posture emphases. Tools with no brief content are omitted from " +
      "the response. Requires hub-protocol.read scope.",
    request: {
      query: z.object({
        tools: z
          .string()
          .openapi({ description: "Comma-separated tool names" }),
        workspaceId: z.string().uuid().optional(),
        door: z.enum(["chat", "automation"]).optional(),
      }),
    },
    responses: {
      200: { description: "Composed briefs", schema: BriefsResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  // Static route — declared before any dynamic /briefs/:id (none today).
  app.get("/briefs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const parsed = BriefsQuerySchema.safeParse({
      tools: c.req.query("tools"),
      workspaceId: c.req.query("workspaceId"),
      door: c.req.query("door"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query params", issues: parsed.error.issues },
        400
      );
    }

    const toolNames = parsed.data.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Identity: userId is already the operator floor (agent-key remap handled
    // by the auth middleware); agentUserId is the acting agent, when set.
    const agentUserId = c.get("agentUserId") as string | undefined;
    const userId = c.get("userId") as string;

    // A brief embeds the target workspace's governance verdict — the caller
    // must be a member of that workspace to read it (same predicate as the
    // GET /workspaces/:id/governance dry-run, which this route mirrors).
    if (parsed.data.workspaceId) {
      const db = await getDb();
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, parsed.data.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
        columns: { role: true },
      });
      if (!membership) return c.json({ error: "Access denied" }, 403);
    }

    const briefs: Record<string, string> = {};
    await Promise.all(
      toolNames.map(async (name) => {
        const brief = await composeCapabilityBrief(name, {
          agentUserId,
          workspaceId: parsed.data.workspaceId ?? null,
          door: parsed.data.door ?? "chat",
        });
        if (brief) briefs[name] = brief;
      })
    );

    return c.json({ briefs }, 200);
  });
}
