/**
 * Hub Protocol - Relation Definitions Router
 *
 * Allows agents to list and create workspace relation definition types.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { relationDefsRouter } from "../relation-defs.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const hubRelationDefsRouter = router({
  list: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        (ctx as any).scopes ?? ["hub-protocol.read"],
        input.workspaceId
      );
      const caller = relationDefsRouter.createCaller(callerContext as any);
      return caller.list();
    }),

  create: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        slug: z.string().regex(/^[a-z][a-z0-9_]*$/),
        displayName: z.string().min(1).max(100),
        description: z.string().optional(),
        isDirectional: z.boolean().optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        input.userId,
        (ctx as any).scopes ?? ["hub-protocol.write"],
        input.workspaceId
      );
      const caller = relationDefsRouter.createCaller(callerContext as any);
      return caller.create({
        slug: input.slug,
        displayName: input.displayName,
        description: input.description,
        isDirectional: input.isDirectional,
        uiHints: input.uiHints,
      });
    }),
});
