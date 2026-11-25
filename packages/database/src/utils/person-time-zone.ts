import { eq } from "drizzle-orm";
import { users } from "../schema/index.js";

/**
 * The person's IANA zone (`users.timezone`): "UTC" when unset, or a name
 * Intl does not know. A failed read throws; each caller decides how it
 * degrades.
 */
export async function personTimeZone(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  userId: string
): Promise<string> {
  const [row] = (await database
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)) as Array<{ timezone: string | null }>;
  const zone = row?.timezone?.trim();
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
