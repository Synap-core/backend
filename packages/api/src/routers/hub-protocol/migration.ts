/**
 * Hub Protocol — Onboarding Migration Router
 *
 * Receives a bulk migration payload from the browser (local anonymous workspace
 * data built during onboarding) and materialises it on the real data pod.
 *
 * Called by the browser's migration engine immediately after the user connects
 * a pod for the first time.
 *
 * Design:
 *   - Single tRPC mutation: `migrate`
 *   - Authenticates via hub-protocol.write scope (same as all hub-protocol writes)
 *   - Delegates to existing inner routers (profiles, propertyDefs, entities, views)
 *     so all validation, audit logging, and side-effects are preserved
 *   - Partial success is acceptable — log failures per-item and continue
 *   - Idempotent: profiles and property defs deduplicate by slug; entities
 *     deduplicate by (workspaceId, profileId, title)
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { createHubProtocolCallerContext } from "./utils.js";
import { assertMayActAs } from "./guard.js";
import { profilesRouter as regularProfilesRouter } from "../profiles.js";
import { propertyDefsRouter as regularPropertyDefsRouter } from "../property-defs.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { viewsRouter as regularViewsRouter } from "../views.js";
import {
  getDb,
  eq,
  resolveIdentity,
  extractIdentitySignals,
} from "@synap/database";
import { entities, workspaces } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "hub-protocol-migration" });

// ─── Input schema ─────────────────────────────────────────────────────────────

const PropertyInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  label: z.string().optional(),
  valueType: z.enum([
    "string",
    "number",
    "boolean",
    "date",
    "entity_id",
    "array",
    "object",
  ]),
  inputType: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
});

const ProfileInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1).max(200),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  properties: z.array(PropertyInputSchema).optional(),
  scope: z.enum(["WORKSPACE", "SYSTEM", "USER"]).optional(),
});

const EntityInputSchema = z.object({
  profileSlug: z.string().min(1),
  title: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
});

const ViewInputSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.string().min(1),
  scopeProfileSlug: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const MigrateInputSchema = z.object({
  userId: z.string(),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().optional(),
  profiles: z.array(ProfileInputSchema).optional().default([]),
  entities: z.array(EntityInputSchema).optional().default([]),
  views: z.array(ViewInputSchema).optional().default([]),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const migrationRouter = router({
  /**
   * Migrate a locally-built anonymous workspace to the real data pod.
   *
   * Creates profiles (with their property definitions), entities, and views
   * in the specified workspace. Operations are idempotent and errors are
   * non-fatal per-item — partial success is returned on the response.
   *
   * Requires: hub-protocol.write scope
   */
  migrate: scopedProcedure(["hub-protocol.write"])
    .input(MigrateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { userId, workspaceId } = input;
      assertMayActAs(ctx, userId);

      logger.info(
        {
          workspaceId,
          userId,
          profileCount: input.profiles.length,
          entityCount: input.entities.length,
          viewCount: input.views.length,
        },
        "migration.migrate: starting onboarding migration"
      );

      // ── 0. Verify workspace exists ───────────────────────────────────────────
      const db = await getDb();
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true, name: true },
      });
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace not found: ${workspaceId}`,
        });
      }

      const callerCtx = await createHubProtocolCallerContext(
        userId,
        ctx.scopes || [],
        workspaceId,
        ctx.sourceMessageId ?? undefined
      );

      let profilesCreated = 0;
      let entitiesCreated = 0;
      let viewsCreated = 0;

      // Map slug → profileId for use when creating entities and views
      const profileIdBySlug = new Map<string, string>();

      // ── 1. Create profiles (and their property defs) ─────────────────────────
      for (const profileInput of input.profiles) {
        try {
          const profileCaller = regularProfilesRouter.createCaller(callerCtx);

          // Map scope from the payload convention to the profiles router convention.
          // Payload uses UPPER_CASE ("WORKSPACE"); profiles router uses lowercase ("workspace").
          const scope =
            profileInput.scope === "SYSTEM"
              ? "system"
              : profileInput.scope === "USER"
                ? "user"
                : "workspace";

          const { profile } = await profileCaller.create({
            slug: profileInput.slug,
            displayName: profileInput.displayName,
            scope,
            // Pack icon + color + description into uiHints so the profiles
            // router stores them consistently with the rest of the codebase.
            uiHints: {
              ...(profileInput.icon ? { icon: profileInput.icon } : {}),
              ...(profileInput.color ? { color: profileInput.color } : {}),
              ...(profileInput.description
                ? { description: profileInput.description }
                : {}),
            },
            source: "intelligence",
          });

          if (!profile) {
            logger.warn(
              { slug: profileInput.slug },
              "migration: profile create returned null"
            );
            continue;
          }
          profileIdBySlug.set(profileInput.slug, String(profile.id));
          profilesCreated++;

          logger.info(
            { profileId: profile.id, slug: profileInput.slug, workspaceId },
            "migration: profile created/resolved"
          );

          // ── 1b. Create property definitions for this profile ─────────────────
          if (profileInput.properties && profileInput.properties.length > 0) {
            for (const prop of profileInput.properties) {
              try {
                const propDefCaller =
                  regularPropertyDefsRouter.createCaller(callerCtx);
                await propDefCaller.create({
                  slug: prop.slug,
                  valueType: prop.valueType as
                    | "string"
                    | "number"
                    | "boolean"
                    | "object"
                    | "array"
                    | "date"
                    | "secret"
                    | "entity_id",
                  profileId: String(profile.id),
                  uiHints: {
                    ...(prop.label ? { label: prop.label } : {}),
                    ...(prop.inputType ? { inputType: prop.inputType } : {}),
                  },
                  constraints:
                    prop.enumValues && prop.enumValues.length > 0
                      ? { enum: prop.enumValues }
                      : undefined,
                });

                logger.info(
                  {
                    slug: prop.slug,
                    profileId: profile.id,
                    workspaceId,
                  },
                  "migration: property def created/resolved"
                );
              } catch (propErr) {
                logger.warn(
                  {
                    err: propErr,
                    slug: prop.slug,
                    profileSlug: profileInput.slug,
                  },
                  "migration: failed to create property def (non-fatal, continuing)"
                );
              }
            }
          }
        } catch (profileErr) {
          logger.warn(
            { err: profileErr, slug: profileInput.slug, workspaceId },
            "migration: failed to create profile (non-fatal, continuing)"
          );
        }
      }

      // ── 2. Create entities ────────────────────────────────────────────────────
      for (const entityInput of input.entities) {
        try {
          // Idempotency check: skip if this subject already exists. Routed
          // through the ONE identity resolver (not a hand-rolled title match) so
          // a re-run first dedups on STRONG signals (email/phone/url — global)
          // and only falls back to a WEAK same-kind name match scoped to this
          // workspace. The exact-title behaviour is preserved (weak match is an
          // exact case-insensitive name match) while strong signals now collapse
          // a re-import onto the real subject regardless of title drift.
          const profileId = profileIdBySlug.get(entityInput.profileSlug);

          if (profileId) {
            const identity = await resolveIdentity(db, {
              userId,
              kindSlug: entityInput.profileSlug,
              name: entityInput.title,
              signals: extractIdentitySignals(entityInput.properties ?? {}),
              userScope: eq(entities.workspaceId, workspaceId),
            });

            if (identity.match && identity.entity) {
              logger.info(
                {
                  title: entityInput.title,
                  profileSlug: entityInput.profileSlug,
                  workspaceId,
                  match: identity.match,
                  matchedEntityId: identity.entity.id,
                },
                "migration: subject already exists (identity match), skipping (idempotent)"
              );
              continue;
            }
          }

          const entityCaller = regularEntitiesRouter.createCaller(callerCtx);
          const result = await entityCaller.create({
            profileSlug: entityInput.profileSlug,
            title: entityInput.title,
            properties: entityInput.properties,
            content: entityInput.content,
            source: "intelligence",
          });

          if (result.status === "created" || result.id) {
            entitiesCreated++;
            logger.info(
              {
                entityId: result.id,
                title: entityInput.title,
                profileSlug: entityInput.profileSlug,
                workspaceId,
              },
              "migration: entity created"
            );
          }
        } catch (entityErr) {
          logger.warn(
            {
              err: entityErr,
              title: entityInput.title,
              profileSlug: entityInput.profileSlug,
              workspaceId,
            },
            "migration: failed to create entity (non-fatal, continuing)"
          );
        }
      }

      // ── 3. Create views ───────────────────────────────────────────────────────
      for (const viewInput of input.views) {
        try {
          // Resolve scopeProfileId from the slug map (or from a fresh DB lookup
          // in case the profile existed before this migration run).
          let scopeProfileId: string | undefined;
          if (viewInput.scopeProfileSlug) {
            scopeProfileId = profileIdBySlug.get(viewInput.scopeProfileSlug);

            if (!scopeProfileId) {
              // Profile may have pre-existed — look it up via the profiles router
              try {
                const profileCaller =
                  regularProfilesRouter.createCaller(callerCtx);
                const { profile } = await profileCaller.get({
                  identifier: viewInput.scopeProfileSlug,
                });
                scopeProfileId = profile?.id;
              } catch {
                // Profile not found — create view without scope
              }
            }
          }

          const viewCaller = regularViewsRouter.createCaller(callerCtx);
          await viewCaller.create({
            workspaceId,
            name: viewInput.name,
            type: viewInput.type,
            scopeProfileIds: scopeProfileId ? [scopeProfileId] : undefined,
            config: viewInput.config,
            source: "intelligence",
          });

          viewsCreated++;
          logger.info(
            { name: viewInput.name, type: viewInput.type, workspaceId },
            "migration: view created"
          );
        } catch (viewErr) {
          logger.warn(
            { err: viewErr, name: viewInput.name, workspaceId },
            "migration: failed to create view (non-fatal, continuing)"
          );
        }
      }

      logger.info(
        {
          workspaceId,
          userId,
          profilesCreated,
          entitiesCreated,
          viewsCreated,
        },
        "migration.migrate: completed"
      );

      return {
        success: true,
        workspaceId,
        profilesCreated,
        entitiesCreated,
        viewsCreated,
      };
    }),
});
