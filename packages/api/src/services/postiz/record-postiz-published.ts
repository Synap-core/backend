/**
 * A Postiz "post published" webhook → the matching Synap `post` moves to
 * Published, carrying its URL and time (Content OS, plan D12).
 *
 * THE PAYLOAD (upstream gitroomhq/postiz-app, read at e7ceab7): the orchestrator
 * calls `sendWebhooks(postsResults[0].postId, orgId, integrationId)` ONLY after
 * a successful publish (`post.workflow.v1.1.2.ts`), which POSTs
 * `JSON.stringify(post)` with no signature header (`post.activity.ts:509-552`),
 * where `post` is a `findMany` — an ARRAY — of
 * `{ id, content, publishDate, releaseURL, state, integration: { id, name,
 * providerIdentifier, picture, type } }` (`posts.repository.ts:1154-1197`).
 * `id` is the Postiz post id, the same `postId` `POST /public/v1/posts`
 * returns (`posts.service.ts` createPost), which a scheduled Synap post holds as
 * `postiz-post-id`. Postiz never sends a webhook for a FAILED publish, so this
 * door only ever records success.
 *
 * WHY A HANDLER, NOT AN AUTOMATION: the move is a FACT a verified external
 * system reports (the path token authenticated it), not a decision. An
 * automation acts as an agent, and an agent's move into a `done` option
 * proposes by default — every published post would wait for a person to
 * confirm what already happened. Server code moving on a verified signal is
 * the `system` actor (`moveStatus`), the same one the Cal.com cancel uses.
 *
 * IDEMPOTENT by state: a re-delivery finds the same values and the status
 * already Published — nothing is written and `moveStatus` answers `unchanged`.
 */
import { z } from "zod";
import { db, and, eq, isNull, drizzleSql, entities } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";
import { moveStatus } from "../lifecycle/move-status.js";

const logger = createLogger({ module: "postiz-published" });

/** The Content OS contract (content-os.yaml `post`). */
export const POSTIZ_POST_ID_PROPERTY = "postiz-post-id";
const PUBLISHED_STATUS = "Published";

const postizWebhookPost = z
  .object({
    id: z.string().min(1),
    releaseURL: z.string().nullish(),
    publishDate: z.string().nullish(),
    state: z.string().nullish(),
    integration: z
      .object({ providerIdentifier: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/** One webhook carries the published post(s) of ONE integration — never many. */
export const postizWebhookPayload = z.array(postizWebhookPost).max(50);
export type PostizWebhookPayload = z.infer<typeof postizWebhookPayload>;

export interface PostizPublishedResult {
  /** Synap posts whose facts or status changed. */
  updated: number;
  /** Payload posts no Synap post (visible to the owner) carries. */
  unmatched: number;
}

export async function recordPostizPublished(args: {
  payload: PostizWebhookPayload;
  /** The Postiz tool's owner — the floor every lookup is made under. */
  ownerUserId: string;
  /** Optional narrow configured on the webhook. */
  workspaceId: string | null;
}): Promise<PostizPublishedResult> {
  let updated = 0;
  let unmatched = 0;
  for (const item of args.payload) {
    if (item.state && item.state !== "PUBLISHED") continue;
    const posts = await db
      .select({
        id: entities.id,
        workspaceId: entities.workspaceId,
        properties: entities.properties,
      })
      .from(entities)
      .where(
        and(
          eq(entities.type, "post"),
          isNull(entities.deletedAt),
          drizzleSql`${entities.properties}->>${POSTIZ_POST_ID_PROPERTY} = ${item.id}`,
          entityWriteVisibleWhere(args.ownerUserId),
          args.workspaceId
            ? eq(entities.workspaceId, args.workspaceId)
            : undefined
        )
      );
    if (posts.length === 0) {
      unmatched += 1;
      continue;
    }

    const facts: Record<string, unknown> = {
      "publish-outcome": "succeeded",
      "publish-error": null,
      ...(item.releaseURL ? { "post-url": item.releaseURL } : {}),
      // Postiz's own record of when it went out: stable across re-deliveries.
      ...(item.publishDate ? { "published-at": item.publishDate } : {}),
    };
    for (const post of posts) {
      const current = (post.properties ?? {}) as Record<string, unknown>;
      const patch = Object.fromEntries(
        Object.entries(facts).filter(
          ([k, v]) => (current[k] ?? null) !== (v ?? null)
        )
      );
      let changed = false;
      if (Object.keys(patch).length > 0) {
        await db
          .update(entities)
          .set({
            properties: drizzleSql`COALESCE(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(entities.id, post.id));
        changed = true;
      }
      const moved = await moveStatus({
        entityId: post.id,
        to: PUBLISHED_STATUS,
        actor: { kind: "system", userId: args.ownerUserId },
        reason: `Published on ${item.integration?.providerIdentifier ?? "a social network"} (Postiz)`,
        workspaceId: post.workspaceId,
      });
      if (moved.status === "moved") changed = true;
      else if (moved.status !== "unchanged") {
        logger.warn(
          { entityId: post.id, moved },
          "postiz webhook: status move to Published not applied"
        );
      }
      if (changed) updated += 1;
    }
  }
  return { updated, unmatched };
}
