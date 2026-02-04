/**
 * Property Definitions Router - Property Management API
 *
 * Handles CRUD operations for property definitions.
 * Property definitions are reusable schemas for entity properties.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  getDb,
  PropertyDefRepository,
  PropertyValueType,
} from "@synap/database";
// PropertySlugConflictError not used, removed
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "property-defs-router" });

const PropertyValueTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "date",
  "entity_id",
  "array",
  "object",
]);

export const propertyDefsRouter = router({
  /**
   * List all property definitions
   */
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    const propertyDefRepo = new PropertyDefRepository(db);

    const propertyDefs = await propertyDefRepo.list();

    return { propertyDefs };
  }),

  /**
   * Get property definition by slug
   */
  get: protectedProcedure
    .input(
      z.object({
        slug: z.string(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      const propertyDef = await propertyDefRepo.getBySlug(input.slug);

      if (!propertyDef) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.slug}`,
        });
      }

      return { propertyDef };
    }),

  /**
   * Create a new property definition
   */
  create: protectedProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        valueType: PropertyValueTypeSchema,
        constraints: z.record(z.string(), z.unknown()).optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Check for slug conflict
      const existing = await propertyDefRepo.getBySlug(input.slug);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Property definition slug already exists: ${input.slug}`,
        });
      }

      const propertyDef = await propertyDefRepo.create({
        slug: input.slug,
        valueType: input.valueType as PropertyValueType,
        constraints: input.constraints,
        uiHints: input.uiHints,
      });

      logger.info(
        {
          propertyDefId: propertyDef.id,
          slug: propertyDef.slug,
          userId: ctx.userId,
        },
        "Property definition created"
      );

      return { propertyDef };
    }),

  /**
   * Update a property definition
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/)
          .optional(),
        valueType: PropertyValueTypeSchema.optional(),
        constraints: z.record(z.string(), z.unknown()).optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Check if property definition exists
      const existing = await propertyDefRepo.getById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.id}`,
        });
      }

      // Check for slug conflict if slug is being changed
      if (input.slug && input.slug !== existing.slug) {
        const conflict = await propertyDefRepo.getBySlug(input.slug);
        if (conflict) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Property definition slug already exists: ${input.slug}`,
          });
        }
      }

      const updated = await propertyDefRepo.update(input.id, {
        slug: input.slug,
        valueType: input.valueType as PropertyValueType | undefined,
        constraints: input.constraints,
        uiHints: input.uiHints,
      });

      logger.info(
        { propertyDefId: updated.id, userId: ctx.userId },
        "Property definition updated"
      );

      return { propertyDef: updated };
    }),

  /**
   * Delete a property definition
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const propertyDefRepo = new PropertyDefRepository(db);

      // Check if property definition exists
      const existing = await propertyDefRepo.getById(input.id);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Property definition not found: ${input.id}`,
        });
      }

      // TODO: Check if property is used by any profiles (prevent deletion if in use)

      await propertyDefRepo.delete(input.id);

      logger.info(
        { propertyDefId: input.id, userId: ctx.userId },
        "Property definition deleted"
      );

      return { success: true };
    }),
});
