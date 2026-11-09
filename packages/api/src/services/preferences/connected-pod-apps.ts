/**
 * The person's connected pod apps — the "app" arm of "Your apps" (founder
 * S4, 5 Nov 2026; rule `./your-apps.ts` `externalApps`): App Connect apps
 * signed in through the pod's own OAuth door (`apps.mode = 'oauth'`), not
 * revoked or removed, each with the homepage its client metadata declares
 * (`oauth_clients.client_uri`). Self-scoped to the caller, like `apps.list`.
 * Two reads, whatever the number of apps. A failed read THROWS: `yourApps`
 * fails rather than show a partial list as if it were all.
 */
import { AppRepository, db, inArray } from "@synap/database";
import { oauthClients } from "@synap/database/schema";
import { isSynapApp } from "../../routers/oauth/config.js";
import type { ExternalAppsPodAppRow } from "./your-apps.js";

export async function readConnectedPodApps(
  userId: string
): Promise<ExternalAppsPodAppRow[]> {
  const rows = (await new AppRepository(db).listForOwner(userId)).filter(
    (r) => r.app.mode === "oauth" && !!r.app.oauthClientId
  );
  if (rows.length === 0) return [];
  const clientIds = rows.map((r) => r.app.oauthClientId!);
  const uris = new Map(
    (
      await db
        .select({
          clientId: oauthClients.clientId,
          clientUri: oauthClients.clientUri,
        })
        .from(oauthClients)
        .where(inArray(oauthClients.clientId, clientIds))
    ).map((c) => [c.clientId, c.clientUri])
  );
  return rows.map((r) => ({
    publicId: r.app.publicId,
    name: r.app.name,
    clientId: r.app.oauthClientId!,
    clientUri: uris.get(r.app.oauthClientId!) ?? null,
    verified: isSynapApp(r.app.oauthClientId!),
  }));
}
