/**
 * AppRepository — the ONE write door for `apps` (App Connect v1, 2026-10-06).
 *
 * An Application is the object a developer registers (the `apps` row); its
 * `public_id` (`app_<uuid>`) is both its stable id AND the `client_id` its
 * grant carries (`grants.client_id`). This repository owns register/upsert
 * (idempotent by owner+name), reads (with the app's live grants and pending
 * request), the approval write (`setApprovedRequests`), rename, revoke and
 * remove. It never mints a key and
 * never touches `grants` directly — the key/grant mint door is the route
 * (`attachGrantOrRevoke` → `GrantRepository`).
 */

import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
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
import { proposals, ProposalStatus } from "../schema/proposals.js";

export interface RegisterAppInput {
  ownerUserId: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  mode?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * One of an app's keys, as the detail surface shows it. Carries no secret:
 * `api_keys` holds a bcrypt hash only. `keyPrefix` is the SCHEME
 * (`synap_hub_live_` …), not the key's own opening characters — those are not
 * stored anywhere and cannot be recovered.
 */
export interface AppKeySummary {
  id: string;
  keyName: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  usageCount: number;
  isActive: boolean;
  revokedAt: Date | null;
}

/**
 * The app's latest still-PENDING `app/connect` request: what it asked for and
 * the proposal a person approves it through. `null` when nothing is waiting.
 */
export interface AppPendingRequest {
  proposalId: string;
  requests: AppApprovedRequest[];
  requestedAt: Date;
}

/**
 * The action segments of an app's lifecycle events (`app.<action>.completed`,
 * `subjectType: "app"`, `app_id` = public_id) — the vocabulary verbs
 * (`@synap-core/types/vocabulary`), so each reads as a past-tense line.
 */
export const APP_EVENT_ACTIONS = {
  requested: "request",
  approved: "approve",
  keyIssued: "issue_key",
  revoked: "revoke",
  renamed: "rename",
  removed: "remove_for_good",
} as const;

/** The `app/connect` proposal coordinates (`POST /apps/:id/connect`). */
export const APP_CONNECT_TARGET_TYPE = "app";
export const APP_CONNECT_PROPOSAL_TYPE = "connect";

/**
 * Read `[{ permission, workspaceId }]` off an `app/connect` proposal payload
 * (`data` or `data.data`). The ONE reader: the approval executor records
 * exactly what the pending projection shows.
 */
export function readAppConnectRequests(raw: unknown): AppApprovedRequest[] {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const inner = (outer.data ?? outer) as Record<string, unknown>;
  const list = inner.requests;
  if (!Array.isArray(list)) return [];
  const out: AppApprovedRequest[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const permission = (item as Record<string, unknown>).permission;
    const workspaceId = (item as Record<string, unknown>).workspaceId;
    if (typeof permission !== "string" || !permission.trim()) continue;
    if (typeof workspaceId !== "string" || !workspaceId.trim()) continue;
    out.push({ permission, workspaceId });
  }
  return out;
}

/** Thrown by `rename` when the owner already has an app of that name. */
export class AppNameTakenError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(readonly appName: string) {
    super(`You already have an app named "${appName}".`);
    this.name = "AppNameTakenError";
  }
}

/** An app plus the grants whose `client_id` is its `public_id`. */
export interface AppWithGrants {
  app: AppRecord;
  /** The latest pending `app/connect` request, or null. */
  pendingRequest: AppPendingRequest | null;
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

/** Newest `api_keys.last_used_at` per key id — ONE query for any number of apps. */
async function keyLastUse(
  dbInstance: PostgresJsDatabase<any>,
  keyIds: string[]
): Promise<Map<string, Date | null>> {
  if (keyIds.length === 0) return new Map();
  const rows = await dbInstance
    .select({ id: apiKeys.id, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(inArray(apiKeys.id, [...new Set(keyIds)]));
  return new Map(rows.map((r) => [r.id, r.lastUsedAt]));
}

function newest(dates: Array<Date | null | undefined>): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d > out)) out = d;
  return out;
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
      // An upsert by NAME must not CLEAR what it was not told about. Registering
      // is idempotent by owner+name (that is the point — re-adding a name you
      // already use opens THAT app), so a caller that supplies only a name would
      // otherwise wipe the description written the first time and reset
      // `mode`/`metadata`. That is silent data loss from a no-op-looking action.
      //
      // `description`/`logo_url` are nullable: `undefined` leaves them, an
      // explicit `null` clears them. `mode`/`metadata` are NOT NULL with
      // defaults, so only a provided non-null value sets them.
      const patch: Partial<typeof apps.$inferInsert> = {
        // A re-register revives a revoked (or removed) app rather than
        // minting a twin — the unique (owner, name) index forbids a twin anyway.
        revokedAt: null,
        removedAt: null,
      };
      if (input.description !== undefined)
        patch.description = input.description;
      if (input.logoUrl !== undefined) patch.logoUrl = input.logoUrl;
      if (input.mode != null) patch.mode = input.mode;
      if (input.metadata != null) patch.metadata = input.metadata;

      const [row] = await this.db
        .update(apps)
        .set(patch)
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
   * Project apps with their live grants, last use and pending request — the
   * ONE projection every read shares (three queries for any number of apps:
   * grants, key use, pending proposals — never one per app).
   */
  private async project(rows: AppRecord[]): Promise<AppWithGrants[]> {
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
          // The key is the bearer: a rotated-away key leaves its grant row
          // un-revoked, so reach is counted only from an ACTIVE key.
          eq(apiKeys.isActive, true)
        )
      );
    const keyUse = await keyLastUse(
      this.db,
      grantRows.map((g) => g.apiKeyId)
    );
    const pendingRows = await this.db
      .select({
        id: proposals.id,
        targetId: proposals.targetId,
        data: proposals.data,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.targetType, APP_CONNECT_TARGET_TYPE),
          eq(proposals.proposalType, APP_CONNECT_PROPOSAL_TYPE),
          eq(proposals.status, ProposalStatus.PENDING),
          inArray(
            proposals.targetId,
            rows.map((r) => r.id)
          )
        )
      )
      .orderBy(desc(proposals.createdAt));
    const pendingByApp = new Map<string, AppPendingRequest>();
    for (const p of pendingRows) {
      if (pendingByApp.has(p.targetId)) continue; // newest first
      pendingByApp.set(p.targetId, {
        proposalId: p.id,
        requests: readAppConnectRequests(p.data),
        requestedAt: p.createdAt,
      });
    }
    return rows.map((app) => {
      const appGrants = grantRows.filter((g) => g.clientId === app.publicId);
      return {
        app,
        pendingRequest: pendingByApp.get(app.id) ?? null,
        // `apps.last_used_at` is the app's own stamp; a v1 app has none, so
        // fall back to the newest use among the app's live keys.
        lastUsedAt:
          app.lastUsedAt ??
          newest(appGrants.map((g) => keyUse.get(g.apiKeyId))),
        grants: appGrants.map(({ apiKeyId: _apiKeyId, ...g }) => g),
      };
    });
  }

  /**
   * One app by its PUBLIC id (`app_<uuid>`) plus its grants, or null. Does NOT
   * check ownership — the caller floors. This is the `:id` the routes key on
   * (the wire contract uses the public id, never the uuid PK). A removed app
   * still resolves here (its history stays reachable); listings drop it.
   */
  async getByPublicId(publicId: string): Promise<AppWithGrants | null> {
    const [app] = await this.db
      .select()
      .from(apps)
      .where(eq(apps.publicId, publicId))
      .limit(1);
    if (!app) return null;
    const [projected] = await this.project([app]);
    return projected;
  }

  /**
   * The owner's apps (newest first) with each app's live grants.
   *
   * Revoked apps are excluded by DEFAULT — the agent-facing `/api/hub/apps`
   * contract treats a revoked app as gone. The human self-service surface
   * (`apps.list`) opts IN with `includeRevoked`, so a revoked app shows under
   * "Removed" instead of silently vanishing. A REMOVED app ("Remove for good")
   * is never listed.
   */
  async listForOwner(
    ownerUserId: string,
    opts: { includeRevoked?: boolean } = {}
  ): Promise<AppWithGrants[]> {
    const where = opts.includeRevoked
      ? and(eq(apps.ownerUserId, ownerUserId), isNull(apps.removedAt))
      : and(
          eq(apps.ownerUserId, ownerUserId),
          isNull(apps.revokedAt),
          isNull(apps.removedAt)
        );
    const rows = await this.db
      .select()
      .from(apps)
      .where(where)
      .orderBy(desc(apps.createdAt));
    return this.project(rows);
  }

  /** One app + its grants, floored on the owner — null when not theirs. */
  async getForOwner(
    appId: string,
    ownerUserId: string
  ): Promise<AppWithGrants | null> {
    const app = await this.get(appId);
    if (!app || app.ownerUserId !== ownerUserId) return null;
    const [projected] = await this.project([app]);
    return projected;
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

  /**
   * An app's keys, as a PERSON reads them: what each key is called, its scheme,
   * when it was made, when it was last used and how often.
   *
   * Never the secret — `api_keys` stores only a bcrypt hash, so there is
   * nothing else to give. That is why an app's key can be listed here and still
   * be unmintable-again from the UI: minting returns the plaintext ONCE, and
   * losing it means minting a new one.
   *
   * The link is the grant: a key minted for an app carries
   * `grants.client_id = apps.public_id` (`keyIdsFor`), which is also what makes
   * its grant resolve. A key whose grants were all revoked is STILL listed —
   * "this app has a revoked key" is a fact about the app, and hiding it would
   * make a revoked app look like one that never had a key.
   */
  async keysFor(publicId: string): Promise<AppKeySummary[]> {
    const keyIds = await this.keyIdsFor(publicId);
    if (keyIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: apiKeys.id,
        keyName: apiKeys.keyName,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        usageCount: apiKeys.usageCount,
        isActive: apiKeys.isActive,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(inArray(apiKeys.id, keyIds));
    // Newest first: the key you just minted is the one you are looking for.
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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

  /**
   * Rename an app. Names are unique per owner (`apps_owner_name_unique`, which
   * is also what `register` is idempotent by): a name the owner already uses
   * on another app is an `AppNameTakenError`, never a raw unique violation.
   */
  async rename(appId: string, name: string): Promise<AppRecord | null> {
    const trimmed = name.trim();
    const app = await this.get(appId);
    if (!app) return null;
    const [twin] = await this.db
      .select({ id: apps.id })
      .from(apps)
      .where(
        and(
          eq(apps.ownerUserId, app.ownerUserId),
          eq(apps.name, trimmed),
          ne(apps.id, appId)
        )
      )
      .limit(1);
    if (twin) throw new AppNameTakenError(trimmed);
    try {
      const [row] = await this.db
        .update(apps)
        .set({ name: trimmed })
        .where(eq(apps.id, appId))
        .returning();
      return row ?? null;
    } catch (err) {
      // A concurrent rename/register took the name between the check and the
      // write — the index is the final word.
      if ((err as { code?: string })?.code === "23505")
        throw new AppNameTakenError(trimmed);
      throw err;
    }
  }

  /** "Remove for good": hide a REVOKED app from every listing (the caller gates). */
  async remove(appId: string): Promise<AppRecord | null> {
    const [row] = await this.db
      .update(apps)
      .set({ removedAt: new Date() })
      .where(eq(apps.id, appId))
      .returning();
    return row ?? null;
  }
}
