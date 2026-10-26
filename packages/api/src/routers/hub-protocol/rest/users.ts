/**
 * Hub Protocol REST — users
 */

import { z } from "@hono/zod-openapi";
import { db, users, inArray } from "@synap/database";

import { registerOpenApi } from "./_codecs/_register.js";
import type { HubHono } from "./_shared.js";

export function registerUsersRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/users/me",
    tags: ["Users"],
    summary: "Echo the authenticated identity",
    description: "Used by the CLI and external agents to verify their API key.",
    responses: {
      200: {
        description: "Identity",
        schema: z.object({
          id: z.string(),
          scopes: z.array(z.string()),
          /** Server-derived credential posture; never accepted from the caller. */
          isAgent: z.boolean(),
          /**
           * Who HOLDS the key (`id` above is the human it acts for): an agent
           * reads its own id here, and the computer it runs on. Null for a
           * caller that is not an API key (a person's session, the IS's
           * delegation).
           */
          principal: z
            .object({
              id: z.string(),
              kind: z.enum(["human", "agent", "machine", "app", "service"]),
              name: z.string().nullable(),
              /** The computer it runs on (itself for a computer); null = no computer. */
              hostUserId: z.string().nullable(),
              hostName: z.string().nullable(),
            })
            .nullable(),
        }),
      },
      401: { description: "Unauthorized" },
    },
  });

  /**
   * GET /users/me — return the authenticated agent/user identity.
   * Used by the CLI and external agents to verify their API key.
   */
  app.get("/users/me", async (c) => {
    const userId = c.get("userId") as string | undefined;
    const scopes = c.get("scopes") as string[] | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    // `agentUserId` is established only by Hub auth middleware after it resolves
    // the bearer key. It is deliberately not a query/body field, so an external
    // client cannot forge agent posture to unlock AI-write surfaces.
    const held = c.get("keyPrincipal");
    const names = held
      ? new Map(
          (
            await db
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(
                inArray(
                  users.id,
                  held.hostUserId ? [held.id, held.hostUserId] : [held.id]
                )
              )
          ).map((r) => [r.id, r.name])
        )
      : null;
    return c.json({
      id: userId,
      scopes: scopes ?? [],
      isAgent: Boolean(c.get("agentUserId")),
      principal:
        held && names
          ? {
              ...held,
              name: names.get(held.id) ?? null,
              hostName: held.hostUserId
                ? (names.get(held.hostUserId) ?? null)
                : null,
            }
          : null,
    });
  });
}
