/**
 * resolveEntityOpenTarget — WHERE opening this entity should go, decided on the
 * pod so every client (browser, relay) only dispatches.
 *
 *   1. The entity is read through the access layer (`scopedDb`): an entity the
 *      caller cannot see is NOT_FOUND, never a calm `internal`.
 *   2. The effective `entity-detail` renderer for its profile kind is resolved
 *      through the one ladder (`getEffectiveRendererWithSource`) with the caller's
 *      `userId`, so a personal `source-app` binding (user × kind) is reachable.
 *   3. Only when that binding is `source-app` AND an active external link that
 *      belongs to the CALLER'S OWN connection yields an honest url
 *      (`externalTargetFor`) is the answer `external`. Anything else — no
 *      binding, no link, no stored url, a link another member's connection
 *      wrote — is `internal`: open it in Synap, which is always a correct place
 *      for a record the pod holds.
 *
 * LINK OWNERSHIP. A pod-scope event can be mirrored by several members; each
 * member's `htmlLink` encodes THEIR calendar (the `eid`), and the event may not
 * be open to anyone else. So a link counts only when its `nango_connection_id`
 * names a `secrets` row (the connection registry) owned by the caller. A link
 * with no such row (the `direct-import` sentinel, or a connection since
 * deleted) has no provable owner and is skipped — fail closed.
 */

import {
  and,
  desc,
  drizzleSql,
  entities,
  entityExternalLinks,
  eq,
  getDb,
  isNull,
  ProfileRepository,
  ProfileResolutionService,
  secrets,
} from "@synap/database";
import { TRPCError } from "@trpc/server";

import { AccessContext, scopedDb } from "../../access/index.js";
import { externalTargetFor } from "./external-target.js";

export type EntityOpenTarget =
  { kind: "external"; provider: string; webUrl: string } | { kind: "internal" };

export interface ResolveEntityOpenTargetInput {
  entityId: string;
  userId: string;
  /** The caller's workspace lens (the same one `getEffectiveRenderers` uses). */
  workspaceId: string | null;
}

export interface OpenTargetLink {
  provider: string;
  url: string | null;
  /**
   * `secrets.user_id` of the connection that wrote the link; `null` when the
   * link names no connection row (sentinel / deleted connection).
   */
  ownerUserId: string | null;
}

/** The four reads the decision needs — injectable so the decision is testable. */
export interface OpenTargetReaders {
  /** Access-scoped. `null` = not visible to this user (or deleted). */
  loadEntity(
    entityId: string,
    userId: string
  ): Promise<{ id: string; profileId: string | null } | null>;
  profileSlug(profileId: string): Promise<string | null>;
  detailRendererKind(
    profileSlug: string,
    workspaceId: string | null,
    userId: string
  ): Promise<string>;
  /** Active links with their connection owner, most recently synced first. */
  activeLinks(entityId: string): Promise<OpenTargetLink[]>;
}

export const podOpenTargetReaders: OpenTargetReaders = {
  async loadEntity(entityId, userId) {
    // `ScopedDb.findFirst` is table-generic and does not narrow on `columns`.
    const row = (await scopedDb(AccessContext.operator({ userId })).findFirst(
      entities,
      {
        where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
        columns: { id: true, profileId: true },
      }
    )) as { id: string; profileId: string | null } | undefined;
    return row ? { id: row.id, profileId: row.profileId ?? null } : null;
  },
  async profileSlug(profileId) {
    const db = await getDb();
    const profile = await new ProfileRepository(db).getById(profileId);
    return profile?.slug ?? null;
  },
  async detailRendererKind(profileSlug, workspaceId, userId) {
    const db = await getDb();
    const { ref } = await new ProfileResolutionService(
      db
    ).getEffectiveRendererWithSource(
      profileSlug,
      workspaceId,
      "entity-detail",
      {
        userId,
      }
    );
    return ref.kind;
  },
  async activeLinks(entityId) {
    // `entity_external_links` has no VisibilityRule of its own: it is read
    // only by an `entityId` the access layer authorized in `loadEntity`.
    // `nango_connection_id` is text (it also holds the `direct-import`
    // sentinel), `secrets.id` is uuid — compare as text so a sentinel simply
    // matches no row instead of failing a uuid cast.
    const db = await getDb();
    return db
      .select({
        provider: entityExternalLinks.provider,
        url: entityExternalLinks.url,
        ownerUserId: secrets.userId,
      })
      .from(entityExternalLinks)
      .leftJoin(
        secrets,
        drizzleSql`${secrets.id}::text = ${entityExternalLinks.nangoConnectionId}`
      )
      .where(
        and(
          eq(entityExternalLinks.entityId, entityId),
          eq(entityExternalLinks.status, "active")
        )
      )
      .orderBy(desc(entityExternalLinks.lastSyncedAt));
  },
};

export async function resolveEntityOpenTarget(
  input: ResolveEntityOpenTargetInput,
  readers: OpenTargetReaders = podOpenTargetReaders
): Promise<EntityOpenTarget> {
  const entity = await readers.loadEntity(input.entityId, input.userId);
  if (!entity) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
  }
  if (!entity.profileId) return { kind: "internal" };

  const slug = await readers.profileSlug(entity.profileId);
  if (!slug) return { kind: "internal" };

  const rendererKind = await readers.detailRendererKind(
    slug,
    input.workspaceId,
    input.userId
  );
  if (rendererKind !== "source-app") return { kind: "internal" };

  for (const link of await readers.activeLinks(entity.id)) {
    // Only the caller's own connection's link (see header: LINK OWNERSHIP).
    if (link.ownerUserId !== input.userId) continue;
    const target = externalTargetFor(link.provider, link.url);
    if (target) {
      return {
        kind: "external",
        provider: link.provider,
        webUrl: target.webUrl,
      };
    }
  }
  return { kind: "internal" };
}
