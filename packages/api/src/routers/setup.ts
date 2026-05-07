import { publicProcedure, router } from "../trpc.js";
import { getDb } from "@synap/database";
import { users } from "@synap/database/schema";
import { kratosAdmin } from "@synap/auth";

/** Check Kratos admin API for any identities. */
async function checkKratosIdentity(): Promise<boolean> {
  try {
    const { data: identities } = await kratosAdmin.listIdentities({
      pageSize: 1,
    });
    return Array.isArray(identities) && identities.length > 0;
  } catch {
    return false;
  }
}

export const setupRouter = router({
  status: publicProcedure.query(async () => {
    // Primary check: Kratos identities (source of truth for auth).
    // Kratos self-service flows (login/registration) create identities
    // in Kratos only — the Synap `users` table is a separate layer.
    const kratosHasIdentity = await checkKratosIdentity();
    if (kratosHasIdentity) {
      return { initialized: true, version: "1.0.0" };
    }

    // Fallback: check Synap `users` table in case Kratos is unreachable
    // or in legacy setups where identities live only in the DB.
    const db = await getDb();
    const [existingUser] = await db.select().from(users).limit(1);

    return {
      initialized: !!existingUser,
      version: "1.0.0",
    };
  }),
});
