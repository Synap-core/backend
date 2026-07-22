/**
 * Hub Protocol REST — /resolve
 *
 * Universal ID resolver. Takes any UUID and returns what type of thing it is.
 * Probes proposals → entities → views → documents in order.
 *
 * AI agents call this when they want to open something but don't know the type.
 * Usage: synap open <id> → CLI calls this endpoint → dispatches the right deep link.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { db } from "@synap/database";
import { proposals, entities, views, documents } from "@synap/database/schema";
import { eq, and, or, isNull, isNotNull } from "drizzle-orm";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { resolveByName } from "../../../services/object-graph/graph-service.js";
import { accessScopeWhere } from "../../../utils/project-scope.js";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";

const ResolveByNameSchema = z
  .object({
    matches: z.array(
      z.object({
        kind: z.string(),
        id: z.string(),
        name: z.string(),
        subtype: z.string().nullable(),
        workspaceId: z.string().nullable(),
      })
    ),
    /** True when exactly one object matched — safe to act on directly. */
    unique: z.boolean(),
  })
  .openapi("ResolveByNameResponse");

const ResolveResponseSchema = z
  .object({
    type: z
      .enum(["proposal", "entity", "view", "document", "unknown"])
      .describe("Discovered type of the given ID"),
    id: z.string().describe("The queried ID"),
    displayName: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    profileSlug: z.string().nullable().optional(),
  })
  .openapi("ResolveResponse");

export function registerResolveRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/resolve/{id}",
    tags: ["System"],
    summary: "Universal ID resolver — what type is this ID?",
    description:
      "Given any UUID, returns what type of thing it is (proposal, entity, view, document, or unknown). " +
      "AI agents use this before opening something in the browser — they don't need to know the type upfront.",
    responses: {
      200: {
        description: "Resolved type information",
        schema: ResolveResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Name-addressing: GET /resolve?kind=&name=&subtype= ───────────────────
  // The dual of /resolve/:id — find an object by its NAME (a handle) instead of
  // its uuid. Names aren't unique pod-wide, so it returns ALL matches + a
  // `unique` flag. Registered BEFORE /resolve/:id (Hono static-before-dynamic).
  registerOpenApi(app, {
    method: "get",
    path: "/resolve",
    tags: ["System"],
    summary: "Resolve an object by NAME (not id)",
    description:
      "Find objects of a given kind by name — the navigable-by-name half of the graph. " +
      "Returns every match (names aren't unique) + `unique`. Pass `subtype` to narrow " +
      "(entity profileSlug, view type, tool/skill kind).",
    request: {
      query: z.object({
        kind: z.string(),
        name: z.string(),
        subtype: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Matches", schema: ResolveByNameSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.get("/resolve", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const kind = c.req.query("kind");
    const name = c.req.query("name");
    const subtype = c.req.query("subtype") || undefined;
    if (!kind || !name) {
      return c.json({ error: "kind and name are required" }, 400);
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const matches = await resolveByName(acting.userId, kind, name, subtype);
    return c.json({ matches, unique: matches.length === 1 }, 200);
  });

  app.get("/resolve/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "id is required" }, 400);
    }

    // Bind the resolve to the acting principal. Each probe below ANDs the
    // acting user's visibility floor onto its `eq(table.id, id)` lookup — without
    // it, resolve returned title + workspaceId for ANY row in the pod (a
    // cross-tenant existence + metadata leak). Not-found (→ `unknown`) is the
    // correct response for an id the caller cannot see.
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const userId = acting.userId;

    async function probe<T>(
      label: string,
      fn: () => Promise<T | undefined>
    ): Promise<T | undefined> {
      try {
        return await fn();
      } catch (err) {
        logger.warn(
          { err, id, table: label },
          "resolve probe failed (continuing)"
        );
        return undefined;
      }
    }

    // 1. Probe proposals first
    const proposal = await probe("proposals", async () => {
      const [row] = await db
        .select({
          id: proposals.id,
          targetType: proposals.targetType,
          targetId: proposals.targetId,
          workspaceId: proposals.workspaceId,
        })
        .from(proposals)
        // Mirror the canonical proposals floor (registry `workspace` rule):
        // visible when the proposal's workspace is one the caller can see.
        .where(
          and(
            eq(proposals.id, id),
            userVisibleWhere(proposals.workspaceId, userId)
          )
        )
        .limit(1);
      return row;
    });
    if (proposal) {
      return c.json({
        type: "proposal",
        id: proposal.id,
        displayName: `Proposal (${proposal.targetType}:${proposal.targetId.slice(0, 8)}…)`,
        workspaceId: proposal.workspaceId,
      });
    }

    // 2. Probe entities (type column = profile slug)
    const entity = await probe("entities", async () => {
      const [row] = await db
        .select({
          id: entities.id,
          title: entities.title,
          workspaceId: entities.workspaceId,
          type: entities.type,
        })
        .from(entities)
        // Canonical DATA-table floor. Display read → facetLens honors role-as-lens.
        .where(
          and(
            eq(entities.id, id),
            accessScopeWhere({
              workspaceIdColumn: entities.workspaceId,
              entityIdColumn: entities.id,
              ownerColumn: entities.userId,
              userId,
              facetLens: true,
            })
          )
        )
        .limit(1);
      return row;
    });
    if (entity) {
      return c.json({
        type: "entity",
        id: entity.id,
        displayName: entity.title,
        workspaceId: entity.workspaceId,
        profileSlug: entity.type,
      });
    }

    // 3. Probe views
    const view = await probe("views", async () => {
      const [row] = await db
        .select({
          id: views.id,
          name: views.name,
          workspaceId: views.workspaceId,
        })
        .from(views)
        // Mirror the canonical views floor (viewVisibleWhere in views.ts):
        // pod-personal (owner) OR workspace-membership. Views carry no facets.
        .where(
          and(
            eq(views.id, id),
            or(
              and(isNull(views.workspaceId), eq(views.userId, userId)),
              and(
                isNotNull(views.workspaceId),
                userVisibleWhere(views.workspaceId, userId)
              )
            )
          )
        )
        .limit(1);
      return row;
    });
    if (view) {
      return c.json({
        type: "view",
        id: view.id,
        displayName: view.name,
        workspaceId: view.workspaceId,
      });
    }

    // 4. Probe documents
    const doc = await probe("documents", async () => {
      const [row] = await db
        .select({
          id: documents.id,
          title: documents.title,
          workspaceId: documents.workspaceId,
        })
        .from(documents)
        // Canonical DATA-table floor (registry documents rule) — NO facetLens
        // (documents have no facets; their id doesn't map to entity_facets).
        .where(
          and(
            eq(documents.id, id),
            accessScopeWhere({
              workspaceIdColumn: documents.workspaceId,
              entityIdColumn: documents.id,
              ownerColumn: documents.userId,
              userId,
            })
          )
        )
        .limit(1);
      return row;
    });
    if (doc) {
      return c.json({
        type: "document",
        id: doc.id,
        displayName: doc.title,
        workspaceId: doc.workspaceId,
      });
    }

    // 5. Not found
    return c.json({
      type: "unknown",
      id,
      displayName: null,
      workspaceId: null,
    });
  });
}
