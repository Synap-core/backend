import { db, tools, eq, drizzleSql } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "webhook-seen" });

/**
 * Race-safe single-leaf write into `metadata.<provider>.webhook.seen[<key>]` on a
 * `tools` row — the shared dedup marker for inbound webhook routes (cal.com,
 * fireflies, mailgun).
 *
 * Computed ENTIRELY in-statement: a nested ensure-chain creates any missing parent
 * objects, and only the ONE leaf key is written. Writing the whole map back from an
 * earlier in-memory snapshot raced concurrent webhooks + the backfill poller — a
 * clobbered key re-mints duplicate rows for providers whose payloads have no
 * identity-signal dedup. `provider` is a TRUSTED constant; `key` (the payload id)
 * rides as a BOUND parameter and is never interpolated into SQL. Path segments use
 * the `ARRAY[...]::text[]` form (matching the leaf write) so `provider` binds safely.
 *
 * Best-effort: a persist failure is logged, never thrown (the caller has already
 * landed the message idempotently; the backfill poller recovers a missed mark).
 */
export async function markWebhookSeen(
  toolId: string,
  provider: string,
  key: string,
  seenAt: string = new Date().toISOString()
): Promise<void> {
  await db
    .update(tools)
    .set({
      metadata: drizzleSql`jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(COALESCE(${tools.metadata}, '{}'::jsonb), ARRAY[${provider}]::text[], COALESCE(${tools.metadata} #> ARRAY[${provider}]::text[], '{}'::jsonb), true),
            ARRAY[${provider},'webhook']::text[], COALESCE(${tools.metadata} #> ARRAY[${provider},'webhook']::text[], '{}'::jsonb), true),
          ARRAY[${provider},'webhook','seen']::text[], COALESCE(${tools.metadata} #> ARRAY[${provider},'webhook','seen']::text[], '{}'::jsonb), true),
        ARRAY[${provider},'webhook','seen',${key}]::text[], ${JSON.stringify(seenAt)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(tools.id, toolId))
    .catch((err) =>
      logger.warn({ err, toolId, provider }, "webhook seen-map persist failed")
    );
}
