/**
 * AppRepository — the ONE write door for `apps` (App Connect v1, 2026-10-06).
 *
 * An Application is the object a developer registers (the `apps` row); its
 * `public_id` (`app_<uuid>`) is both its stable id AND the `client_id` its
 * grant carries (`grants.client_id`). This repository owns register/upsert
 * (idempotent by owner+name), reads (with the app's live grants), the
 * approval write (`setApprovedRequests`) and revoke. It never mints a key and
 * never touches `grants` directly — the key/grant mint door is the route
 * (`attachGrantOrRevoke` → `GrantRepository`).
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db } from "../client-pg.js";
import {
  apps,
  type AppApprovedRequest,
  type AppRecord,
} from "../schema/apps.js";
import { apiKeys } from "../schema/api-keys.js";
import { grants } from "../schema/grants.js";

export interface RegisterAppInput {
  ownerUserId: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  mode?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** An app plus the grants whose `client_id` is its `public_id`. */
export interface AppWithGrants {
  app: AppRecord;
  /**
   * When the app was last used. `apps.last_used_at` is the app's own stamp;
   * a v1 app has none, so the value falls back to the newest `api_keys
   * .last_used_at` among the app's keys — the real, observed "last used".
   */
  lastUsedAt: Date | null;
  grants: Array<{
    id: string;
    permissions: string[];
    workspaceIds: string[] | null;
    projectIds: string[] | null;
    entityIds: string[] | null;
    label: string | null;
    clientId: string | null;
    createdAt: Date;
    revokedAt: Date | null;
  }>;
}

/** The projection every read shares, so list and get cannot drift. */
const GRANT_COLUMNS = {
  id: grants.id,
  permissions: grants.permissions,
  workspaceIds: grants.workspaceIds,
  projectIds: grants.projectIds,
  entityIds: grants.entityIds,
  label: grants.label,
  clientId: grants.clientId,
  createdAt: grants.createdAt,
  revokedAt: grants.revokedAt,
  apiKeyId: grants.apiKeyId,
} as const;

/** Newest `api_keys.last_used_at` across an app's key ids, or null. */
async function newestKeyUse(
  dbInstance: PostgresJsDatabase<any>,
  keyIds: string[]
): Promise<Date | null> {
  if (keyIds.length === 0) return null;
  const rows = await dbInstance
    .select({ lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(inArray(apiKeys.id, keyIds));
  let newest: Date | null = null;
  for (const r of rows) {
    if (r.lastUsedAt && (!newest || r.lastUsedAt > newest)) {
      newest = r.lastUsedAt;
    }
  }
  return newest;
}

/** `app_<lowercased-uuid>` — the stable public id, used verbatim as `client_id`. */
function makePublicId(): string {
  return `app_${randomUUID().toLowerCase()}`;
}

export class AppRepository {
  private readonly db: PostgresJsDatabase<any>;

  constructor(dbInstance: PostgresJsDatabase<any> = db) {
    this.db = dbInstance;
  }

  /**
   * Register (or update) an app for `ownerUserId`, idempotent by owner+name.
   * A previously revoked app of the same name is revived (clears `revoked_at`).
   * The `public_id` is minted once and NEVER changes across upserts.
   */
  async register(input: RegisterAppInput): Promise<AppRecord> {
    const name = input.name.trim();
    const [existing] = await this.db
      .select()
      .from(apps)
      .where(and(eq(apps.ownerUserId, input.ownerUserId), eq(apps.name, name)))
      .limit(1);

    if (existing) {
      const [row] = await this.db
        .update(apps)
        .set({
          description: input.description ?? null,
          logoUrl: input.logoUrl ?? null,
          mode: input.mode ?? "specific",
          metadata: input.metadata ?? {},
          // A re-register revives a revoked app rather than minting a twin.
          revokedAt: null,
        })
        .where(eq(apps.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await this.db
      .insert(apps)
      .values({
        ownerUserId: input.ownerUserId,
        publicId: makePublicId(),
        name,
        description: input.description ?? null,
        logoUrl: input.logoUrl ?? null,
        mode: input.mode ?? "specific",
        metadata: input.metadata ?? {},
      })
      .returning();
    return row;
  }

  /** One app by id, or null. Does NOT check ownership — the caller floors. */
  async get(appId: string): Promise<AppRecord | null> {
    const [row] = await this.db
      .select()
      .from(apps)
      .where(eq(apps.id, appId))
      .limit(1);
    return row ?? null;
  }

  /**
   * One app by its PUBLIC id (`app_<uuid>`) plus its grants, or null. Does NOT
   * check ownership — the caller floors. This is the `:id` the routes key on
   * (the wire contract uses the public id, never the uuid PK).
   */
  async getByPublicId(publicId: string): Promise<AppWithGrants | null> {
    const [app] = await this.db
      .select()
      .from(apps)
      .where(eq(apps.publicId, publicId))
      .limit(1);
    if (!app) return null;
    const grantRows = await this.db
      .select(GRANT_COLUMNS)
      .from(grants)
      .innerJoin(apiKeys, eq(grants.apiKeyId, apiKeys.id))
      .where(
        and(
          eq(grants.clientId, app.publicId),
          isNull(grants.revokedAt),
          // The key is the bearer: a rotated-away key leaves its grant row
          // un-revoked, so reach is counted only from an ACTIVE key.
          eq(apiKeys.isActive, true)
        )
      );
    const keyUse = await newestKeyUse(
      this.db,
      grantRows.map((g) => g.apiKeyId)
    );
    return {
      app,
      lastUsedAt: app.lastUsedAt ?? keyUse,
      grants: grantRows.map(({ apiKeyId: _apiKeyId, ...g }) => g),
    };
  }

  /**
   * The owner's apps (newest first) with each app's live grants.
   *
   * Revoked apps are excluded by DEFAULT — the agent-facing `/api/hub/apps`
   * contract treats a revoked app as gone. The human self-service surface
   * (`apps.list` → pod-admin) opts IN with `includeRevoked`, so a revoked app
   * shows under "Revoked" instead of silently vanishing. A revoked app's live
   * grants read empty here because revoke revokes its keys (`apps.revoke`), and
   * this projection only counts reach from an ACTIVE key.
   */
  async listForOwner(
    ownerUserId: string,
    opts: { includeRevoked?: boolean } = {}
  ): Promise<AppWithGrants[]> {
    const where = opts.includeRevoked
      ? eq(apps.ownerUserId, ownerUserId)
      : and(eq(apps.ownerUserId, ownerUserId), isNull(apps.revokedAt));
    const rows = await this.db
      .select()
      .from(apps)
      .where(where)
      .orderBy(desc(apps.createdAt));
    if (rows.length === 0) return [];

    const publicIds = rows.map((r) => r.publicId);
    const grantRows = await this.db
      .select(GRANT_COLUMNS)
      .from(grants)
      .innerJoin(apiKeys, eq(grants.apiKeyId, apiKeys.id))
      .where(
        and(
          inArray(grants.clientId, publicIds),
          isNull(grants.revokedAt),
          // Live reach only: a grant whose key was rotated away is not reach.
          eq(apiKeys.isActive, true)
        )
      );

    const out: AppWithGrants[] = [];
    for (const app of rows) {
      const appGrants = grantRows.filter((g) => g.clientId === app.publicId);
      const keyUse = await newestKeyUse(
        this.db,
        appGrants.map((g) => g.apiKeyId)
      );
      out.push({
        app,
        lastUsedAt: app.lastUsedAt ?? keyUse,
        grants: appGrants.map(({ apiKeyId: _apiKeyId, ...g }) => g),
      });
    }
    return out;
  }

  /** One app + its grants, floored on the owner — null when not theirs. */
  async getForOwner(
    appId: string,
    ownerUserId: string
  ): Promise<AppWithGrants | null> {
    const app = await this.get(appId);
    if (!app || app.ownerUserId !== ownerUserId) return null;
    const grantRows = await this.db
      .select(GRANT_COLUMNS)
      .from(grants)
      .innerJoin(apiKeys, eq(grants.apiKeyId, apiKeys.id))
      .where(
        and(
          eq(grants.clientId, app.publicId),
          isNull(grants.revokedAt),
          eq(apiKeys.isActive, true)
        )
      );
    const keyUse = await newestKeyUse(
      this.db,
      grantRows.map((g) => g.apiKeyId)
    );
    return {
      app,
      lastUsedAt: app.lastUsedAt ?? keyUse,
      grants: grantRows.map(({ apiKeyId: _apiKeyId, ...g }) => g),
    };
  }

  /**
   * The approval write — the `app/connect` executor's ONLY effect. Records what
   * the human approved. Mints nothing (the key is minted on demand by
   * `POST /apps/:id/key`).
   */
  async setApprovedRequests(
    appId: string,
    requests: AppApprovedRequest[]
  ): Promise<AppRecord | null> {
    const [row] = await this.db
      .update(apps)
      .set({ approvedRequests: requests })
      .where(eq(apps.id, appId))
      .returning();
    return row ?? null;
  }

  /**
   * The api_keys ids bound to this app (via the grants whose `client_id` is the
   * app's `public_id`). Used by the revoke door to revoke the app's keys.
   */
  async keyIdsFor(publicId: string): Promise<string[]> {
    const rows = await this.db
      .select({ apiKeyId: grants.apiKeyId })
      .from(grants)
      .where(eq(grants.clientId, publicId));
    return [...new Set(rows.map((r) => r.apiKeyId))];
  }

  /** Soft-revoke the app (the route revokes its keys first). */
  async revoke(appId: string): Promise<AppRecord | null> {
    const [row] = await this.db
      .update(apps)
      .set({ revokedAt: new Date() })
      .where(eq(apps.id, appId))
      .returning();
    return row ?? null;
  }
}
