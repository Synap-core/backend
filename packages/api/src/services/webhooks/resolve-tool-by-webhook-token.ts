/**
 * One door for "which `<provider>` tool row does this inbound webhook belong
 * to?".
 *
 * The cal.com / fireflies / mailgun webhook handlers used to do:
 *   db.query.tools.findFirst({ where: eq(tools.name, "<provider>") })
 * — no workspace filter, no token filter, no ORDER BY — then compare the
 * SINGLE row it happened to get back against the incoming `:token`. On a pod
 * with more than one `<provider>` tool row (one per workspace) that is a coin
 * flip: Postgres can return ANY row, so a legitimate webhook 404s whenever the
 * arbitrary row picked isn't the one whose secret matches — even though a
 * matching row exists for a DIFFERENT workspace. Same failure class as the
 * discord event-sync bug (see ../tools/resolve-tool.ts), just surfacing as a
 * silent webhook drop instead of a contradictory cron answer.
 *
 * Selection here is NOT "prefer enabled, else oldest" (there is no caller
 * workspace to prefer) — the token IS the identity. Scan every row with this
 * tool name and return the one whose `metadata[domainKey].webhook.token`
 * equals the presented token — compared with `timingSafeEqual`, the same
 * idiom this file's callers (webhooks-inbound.ts) already use for their HMAC
 * checks. For fireflies specifically, when no `secretVaultRef` is configured
 * this token is the SOLE shared secret (no HMAC follows), so it is the one
 * comparison in that path with any real stakes; cal.com and mailgun both
 * require a vault-secret HMAC afterwards regardless.
 */
import { timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@synap/database";
import { tools } from "@synap/database/schema";

export interface ResolvedWebhookTool {
  id: string;
  createdBy: string;
  workspaceId: string | null;
  metadata: unknown;
}

function tokensMatch(candidate: string, presented: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(presented);
  // timingSafeEqual throws on unequal lengths — the length check itself
  // leaks length, same as every other timingSafeEqual call site in this
  // repo; only the byte-content comparison needs to be constant-time.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function resolveToolByWebhookToken(
  toolName: string,
  domainKey: string,
  token: string
): Promise<ResolvedWebhookTool | null> {
  if (!token) return null;
  const rows = await db.query.tools.findMany({
    where: eq(tools.name, toolName),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
  return (
    rows.find((r) => {
      const domain = (r.metadata as Record<string, unknown> | null)?.[
        domainKey
      ] as { webhook?: { token?: string } } | undefined;
      const candidate = domain?.webhook?.token;
      return typeof candidate === "string" && tokensMatch(candidate, token);
    }) ?? null
  );
}
