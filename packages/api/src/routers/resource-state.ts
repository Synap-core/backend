import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  UserResourceStateRepository,
  and,
  db,
  entities,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  views,
} from "@synap/database";
import { protectedProcedure, router } from "../trpc.js";
import { accessScopeWhere } from "../utils/project-scope.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";

const resourceTypeSchema = z.enum(["entity", "view"]);
const semanticSizeSchema = z.enum(["small", "medium", "large"]);

const resourceIdentitySchema = z.object({
  resourceId: z.string().uuid(),
  resourceType: resourceTypeSchema,
});

function entityVisibleWhere(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
  });
}

function viewVisibleWhere(userId: string) {
  return or(
    and(isNull(views.workspaceId), eq(views.userId, userId)),
    and(
      isNotNull(views.workspaceId),
      userVisibleWhere(views.workspaceId, userId)
    )
  )!;
}

async function assertResourceVisible(
  userId: string,
  resourceId: string,
  resourceType: "entity" | "view"
): Promise<void> {
  const resource =
    resourceType === "entity"
      ? await db.query.entities.findFirst({
          where: and(
            eq(entities.id, resourceId),
            isNull(entities.deletedAt),
            entityVisibleWhere(userId)
          ),
          columns: { id: true },
        })
      : await db.query.views.findFirst({
          where: and(eq(views.id, resourceId), viewVisibleWhere(userId)),
          columns: { id: true },
        });

  if (!resource) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Resource not found",
    });
  }
}

async function filterVisibleResources(
  userId: string,
  resources: readonly z.infer<typeof resourceIdentitySchema>[]
): Promise<z.infer<typeof resourceIdentitySchema>[]> {
  const entityIds = Array.from(
    new Set(
      resources
        .filter((resource) => resource.resourceType === "entity")
        .map((resource) => resource.resourceId)
    )
  );
  const viewIds = Array.from(
    new Set(
      resources
        .filter((resource) => resource.resourceType === "view")
        .map((resource) => resource.resourceId)
    )
  );
  const [visibleEntities, visibleViews] = await Promise.all([
    entityIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              inArray(entities.id, entityIds),
              isNull(entities.deletedAt),
              entityVisibleWhere(userId)
            )
          ),
    viewIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: views.id })
          .from(views)
          .where(and(inArray(views.id, viewIds), viewVisibleWhere(userId))),
  ]);
  const visible = new Set([
    ...visibleEntities.map((resource) => `entity:${resource.id}`),
    ...visibleViews.map((resource) => `view:${resource.id}`),
  ]);
  return resources.filter((resource) =>
    visible.has(`${resource.resourceType}:${resource.resourceId}`)
  );
}

export const resourceStateRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        resources: z.array(resourceIdentitySchema).max(5000),
      })
    )
    .query(async ({ input, ctx }) => {
      const visibleResources = await filterVisibleResources(
        ctx.userId,
        input.resources
      );
      const repository = new UserResourceStateRepository(db);
      const states = await repository.getMany(ctx.userId, visibleResources);
      return { states };
    }),

  get: protectedProcedure
    .input(resourceIdentitySchema)
    .query(async ({ input, ctx }) => {
      await assertResourceVisible(
        ctx.userId,
        input.resourceId,
        input.resourceType
      );
      const repository = new UserResourceStateRepository(db);
      const state = await repository.get(
        ctx.userId,
        input.resourceId,
        input.resourceType
      );
      return { state: state ?? null };
    }),

  set: protectedProcedure
    .input(
      resourceIdentitySchema
        .extend({
          pinned: z.boolean().optional(),
          starred: z.boolean().optional(),
          semanticSize: semanticSizeSchema.nullable().optional(),
        })
        .refine(
          (input) =>
            input.pinned !== undefined ||
            input.starred !== undefined ||
            input.semanticSize !== undefined,
          { message: "At least one state field is required" }
        )
    )
    .mutation(async ({ input, ctx }) => {
      await assertResourceVisible(
        ctx.userId,
        input.resourceId,
        input.resourceType
      );
      const repository = new UserResourceStateRepository(db);
      const state = await repository.update(
        ctx.userId,
        input.resourceId,
        input.resourceType,
        {
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(input.starred !== undefined ? { starred: input.starred } : {}),
          ...(input.semanticSize !== undefined
            ? { semanticSize: input.semanticSize }
            : {}),
        }
      );
      return { state };
    }),

  open: protectedProcedure
    .input(resourceIdentitySchema)
    .mutation(async ({ input, ctx }) => {
      await assertResourceVisible(
        ctx.userId,
        input.resourceId,
        input.resourceType
      );
      const repository = new UserResourceStateRepository(db);
      const state = await repository.recordOpen(
        ctx.userId,
        input.resourceId,
        input.resourceType
      );
      return { state };
    }),
});
