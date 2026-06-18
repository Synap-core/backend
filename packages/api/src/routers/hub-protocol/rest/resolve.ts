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
import { eq } from "drizzle-orm";
import { hasScope, logger, type HubHono } from "./_shared.js";

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
        .where(eq(proposals.id, id))
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
        .where(eq(entities.id, id))
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
        .where(eq(views.id, id))
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
        .where(eq(documents.id, id))
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
