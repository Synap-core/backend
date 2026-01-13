import { publicProcedure, router } from "../trpc.js";
import { getDb } from "@synap/database";
import { users } from "@synap/database/schema";

export const setupRouter = router({
  status: publicProcedure.query(async () => {
    const db = await getDb();

    // Check if any users exist (limit 1 is sufficient)
    const [existingUser] = await db.select().from(users).limit(1);

    const initialized = !!existingUser;

    return {
      initialized,
      version: "1.0.0", // Could pull from package.json in future
    };
  }),
});
