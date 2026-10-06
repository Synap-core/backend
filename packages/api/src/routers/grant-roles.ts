/**
 * grantRoles — a person's reusable, named permission lists.
 *
 * A role is `{ id, name, description, grant }` — the `GrantRole` shape the
 * grant selector already shows for the built-in presets
 * (`@synap-core/types/grants`), so presets and stored roles render alike.
 * Minting from a role copies its grant and stamps `grants.role_id` (lineage);
 * editing a role never changes a key that already exists.
 *
 * Writes are the PERSON's: an agent key may read its human's roles (to suggest
 * one) but never author or edit one — a role a person later picks by name
 * must say what the person last saw it say.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, GrantRoleRepository } from "@synap/database";
import type { GrantRoleRecord } from "@synap/database/schema";
import { router, protectedProcedure } from "../trpc.js";
import {
  GrantInputSchema,
  ExpiresInDaysSchema,
  assertGrantInput,
} from "../services/key-grant.js";

const RoleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400).optional(),
  grant: GrantInputSchema.omit({ label: true, roleId: true }).extend({
    /** A number of days, null = never, omitted = the role sets no lifetime. */
    expiresInDays: ExpiresInDaysSchema,
  }),
});

/** The wire shape — `GrantRole` from `@synap-core/types/grants`, plus dates. */
function toRole(row: GrantRoleRecord) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stored: true as const,
    grant: {
      permissions: row.permissions,
      ...(row.workspaceIds ? { workspaceIds: row.workspaceIds } : {}),
      ...(row.projectIds ? { projectIds: row.projectIds } : {}),
      ...(row.entityIds ? { entityIds: row.entityIds } : {}),
      ...(row.neverExpires
        ? { expiresInDays: null }
        : row.expiresInDays !== null
          ? { expiresInDays: row.expiresInDays }
          : {}),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function refuseAgent(ctx: { agentUserId?: string | null }): void {
  if (ctx.agentUserId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only a person can create or change an access role.",
    });
}

const repo = () => new GrantRoleRepository(db);

export const grantRolesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    (await repo().listForUser(ctx.userId)).map(toRole)
  ),

  create: protectedProcedure
    .input(RoleInputSchema)
    .mutation(async ({ ctx, input }) => {
      refuseAgent(ctx);
      assertGrantInput(input.grant);
      const { expiresInDays, ...grant } = input.grant;
      return toRole(
        await repo().create(ctx.userId, {
          name: input.name,
          description: input.description,
          ...grant,
          expiresInDays,
        })
      );
    }),

  update: protectedProcedure
    .input(RoleInputSchema.extend({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      refuseAgent(ctx);
      assertGrantInput(input.grant);
      const { expiresInDays, ...grant } = input.grant;
      const row = await repo().update(ctx.userId, input.id, {
        name: input.name,
        description: input.description,
        ...grant,
        expiresInDays,
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return toRole(row);
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      refuseAgent(ctx);
      if (!(await repo().archive(ctx.userId, input.id)))
        throw new TRPCError({ code: "NOT_FOUND" });
      return { archived: true as const };
    }),
});
