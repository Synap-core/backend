/**
 * Kratos Webhook Utilities
 *
 * Syncs Kratos identity updates (email / name changes) into the Synap
 * users table. Identity creation and federation projection are handled by
 * authenticated Pod endpoints, never by Kratos webhooks.
 */

import { kratosAdmin } from "@synap/auth";
import { getDb } from "@synap/database";
import { users } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "kratos-sync" });

/**
 * Sync user from Kratos to Synap DB
 * Called by webhook when identity is created/updated
 */
export async function syncUserFromKratos(identityId: string): Promise<void> {
  const db = await getDb();

  try {
    // Fetch identity from Kratos
    const { data: identity } = await kratosAdmin.getIdentity({
      id: identityId,
    });

    // Upsert user record
    await db
      .insert(users)
      .values({
        id: identity.id,
        email: identity.traits.email as string,
        name: (identity.traits.name as string) || null,
        emailVerified: identity.verifiable_addresses?.[0]?.verified || false,
        kratosIdentityId: identity.id,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: identity.traits.email as string,
          name: (identity.traits.name as string) || null,
          emailVerified: identity.verifiable_addresses?.[0]?.verified || false,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    logger.info({ userId: identity.id }, "Synced user from Kratos");
  } catch (error) {
    logger.error({ err: error, identityId }, "Failed to sync user from Kratos");
    throw error;
  }
}
