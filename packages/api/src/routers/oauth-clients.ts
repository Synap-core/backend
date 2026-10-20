/**
 * oauthClients — the pod admin's door to the clients its OWN OAuth
 * authorization server registered (Claude / MCP pointed straight at the pod).
 * Read through the keys each client minted; revoke stops those keys and keeps
 * the registration (`services/oauth-client-inventory.ts` says why). Pod admin
 * only: a member reaches their own Claude key through `apiKeys.*`.
 */

import { z } from "zod";
import { router, podAdminProcedure } from "../trpc.js";
import { assertOwnerCredential } from "../services/app-connect.js";
import {
  getOauthClient,
  listOauthClients,
  revokeOauthClient,
} from "../services/oauth-client-inventory.js";

const ClientId = z.string().min(1).max(200);

export const oauthClientsRouter = router({
  /** Every client a person connected (`includeUnused`: every registration). */
  adminList: podAdminProcedure
    .input(z.object({ includeUnused: z.boolean().optional() }).optional())
    .query(({ input }) =>
      listOauthClients({ includeUnused: input?.includeUnused })
    ),

  /** One client with every key minted for it — the console's app page. */
  adminGet: podAdminProcedure
    .input(z.object({ clientId: ClientId }))
    .query(({ input }) => getOauthClient(input.clientId)),

  /**
   * Stop every key the client minted and burn its waiting codes. Idempotent.
   * The admin signed in as themselves only — an agent key resolves `userId`
   * to the admin it acts for, so without the check a pod admin's agent could
   * cut off any app; same rule as `apps.adminRevoke`.
   */
  adminRevoke: podAdminProcedure
    .input(z.object({ clientId: ClientId }))
    .mutation(({ ctx, input }) => {
      assertOwnerCredential("revoke an app", { agentUserId: ctx.agentUserId });
      return revokeOauthClient({
        clientId: input.clientId,
        actorUserId: ctx.userId,
      });
    }),
});
