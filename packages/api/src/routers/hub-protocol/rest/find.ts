/**
 * Hub Protocol REST — GET /find: "what is there for this?", by its words.
 *
 * The Hub REST door of the ONE find service (`findForCaller`,
 * `services/capabilities/find-intent.ts`): runnable verbs, intents,
 * playbooks, spaces, and every object that can be OPENED (records, skills and
 * rules, automations, sessions, goals, projects, views, documents), each object row
 * with its `open` link. MCP `synap_find` and tRPC `knowledge.find` call the
 * same function, so a Hub key (Raycast, the CLI, a pod app) gets the answer
 * an agent and the browser get. A thin adapter: no ranking, no catalog list,
 * no floor of its own.
 *
 *   ?query=      what to find, in the caller's words (required)
 *   ?workspaceId= the lens; a space the caller cannot read is a 403
 *   ?catalogs=a,b which catalogs to search (`FIND_CATALOGS`); omit for all
 *   ?limit=      max matches per catalog (1-25, default 5)
 *   ?depth=      `instant` skips installed recipes + marketplace; default `full`
 *
 * ABSENT ≠ EMPTY per catalog, as on the other doors: a block missing from the
 * answer was not searched, `matches: []` was searched and nothing fit, and
 * `error` means that catalog's read failed. A find that fails as a whole is an
 * error status, never an empty answer.
 *
 * Gate: `hub-protocol.read`; a key the grant fence bounds passes only through
 * the fence declaration this route shares with `synap_find` (`FIND`,
 * `access/grant-door-fence.ts`).
 */
import { z } from "@hono/zod-openapi";
import {
  FIND_CATALOGS,
  findForCaller,
} from "../../../services/capabilities/find-intent.js";
import { OBJECT_CATALOGS } from "../../../services/capabilities/find-objects.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { ErrorSchema, uuidQueryParam } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
} from "./_shared.js";

/** The query string, with the same bounds as tRPC `knowledge.find`. */
const FindQuerySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  workspaceId: uuidQueryParam.optional(),
  catalogs: z
    .string()
    .optional()
    .openapi({
      description: `Comma-separated, some of: ${FIND_CATALOGS.join(", ")}. Omit for all.`,
    }),
  limit: z.coerce.number().int().min(1).max(25).optional(),
  depth: z.enum(["instant", "full"]).optional().openapi({
    description:
      "`instant` skips installed recipes and the marketplace (absent, not empty), for a bar that asks per keystroke. Default `full`.",
  }),
});

/** Comma list → catalog names, each one a member of `FIND_CATALOGS`. */
const CatalogListSchema = z.array(z.enum(FIND_CATALOGS)).min(1);

/** One object a query landed on (`FoundObject`, find-objects.ts). */
const FoundObjectSchema = z
  .object({
    kind: z.string(),
    id: z.string(),
    title: z.string(),
    why: z.string().nullable(),
    open: z.string(),
    ref: z.string().optional(),
    profileSlug: z.string().optional(),
    roles: z.array(z.string()).optional(),
    workspaceId: z.string().nullable(),
    score: z.number(),
    confidence: z.number(),
    match: z.object({
      terms: z.array(z.string()),
      fields: z.array(z.string()),
    }),
    termCoverage: z.object({ hit: z.number(), of: z.number() }),
  })
  .openapi("FoundObject");

/** One object catalog's block: searched (`matches`) or failed (`error`). */
const FindObjectsSchema = z.union([
  z.object({ matches: z.array(FoundObjectSchema) }),
  z.object({ error: z.string() }),
]);

/**
 * The answer (`FindByIntentResult`). The object catalogs are typed rows,
 * keyed from `OBJECT_CATALOGS`; the other blocks keep the service's own shape
 * (`find-intent.ts` documents each).
 */
const FindResultSchema = z
  .object({
    intent: z.string(),
    lens: z.object({ workspaceId: z.string().nullable() }),
    scoring: z.record(z.string(), z.unknown()),
    coverage: z.record(z.string(), z.unknown()),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    intents: z.record(z.string(), z.unknown()).optional(),
    marketplace: z.record(z.string(), z.unknown()).optional(),
    playbooks: z.record(z.string(), z.unknown()).optional(),
    spaces: z.record(z.string(), z.unknown()).optional(),
    noConfidentMatch: z.record(z.string(), z.unknown()).optional(),
    ...Object.fromEntries(
      OBJECT_CATALOGS.map((c) => [c, FindObjectsSchema.optional()])
    ),
  })
  .openapi("FindResult");

export function registerFindRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/find",
    tags: ["Knowledge"],
    summary: "Find what is there for this: verbs, playbooks, spaces, objects",
    description:
      "The find door (the same service as MCP synap_find and tRPC knowledge.find): runnable " +
      "capabilities, intents, playbooks, spaces, and the objects that can be opened (records, skills and " +
      "rules, automations, sessions, goals, projects, views, documents), each object with its " +
      "`open` link. A catalog absent from the answer was not searched; `matches: []` was " +
      "searched and nothing fit; `error` means that catalog's read failed. To recall CONTENT " +
      "(entities, runbooks, captures) use POST /knowledge/search. Requires hub-protocol.read.",
    request: { query: FindQuerySchema },
    responses: {
      200: { description: "What was found", schema: FindResultSchema },
      400: { description: "Invalid query", schema: ErrorSchema },
      403: {
        description:
          "Missing scope, outside the grant, or a space you cannot read",
        schema: ErrorSchema,
      },
      500: { description: "The find failed", schema: ErrorSchema },
    },
  });

  app.get("/find", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    const parsed = FindQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        400
      );
    }
    const q = parsed.data;
    let catalogs: (typeof FIND_CATALOGS)[number][] | undefined;
    if (q.catalogs !== undefined) {
      const list = CatalogListSchema.safeParse(
        q.catalogs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      if (!list.success) {
        return c.json(
          { error: `catalogs takes some of: ${FIND_CATALOGS.join(", ")}.` },
          400
        );
      }
      catalogs = list.data;
    }

    try {
      // A key bound to a space is confined to it (a 403 for another space).
      const workspaceId = getConfinedWorkspace(c, q.workspaceId || null);
      const agentUserId = c.get("agentUserId") as string | undefined;
      const found = await findForCaller({
        intent: q.query,
        workspaceId: workspaceId ?? null,
        userId,
        ...(agentUserId ? { agentUserId } : {}),
        ...(catalogs ? { catalogs } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.depth ? { depth: q.depth } : {}),
      });
      if (!found.ok) {
        return c.json(
          { error: `No access to workspace ${found.forbidden}` },
          403
        );
      }
      return c.json(found.result, 200);
    } catch (err) {
      const status = httpStatusForTrpcError(err);
      if (status === 500) logger.error({ err, userId }, "GET /find failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        status
      ) as never;
    }
  });
}
