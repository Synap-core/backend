import { db, users, inArray } from "@synap/database";

/**
 * Resolve display names for a batch of user IDs (agents + humans): the user's
 * name, else an agent's type / description, else the email. An id with none
 * of these is absent from the map — the caller says "an agent" / "someone",
 * never the id. Shared by the activity feed and the document version rail.
 */
export async function resolveActorNames(
  userIds: string[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(inArray(users.id, unique));

  const map = new Map<string, string>();
  for (const row of rows) {
    let label: string | undefined = row.name ?? undefined;
    if (!label && row.userType === "agent") {
      label =
        row.agentMetadata?.agentType ??
        row.agentMetadata?.description ??
        undefined;
    }
    if (!label) label = row.email ?? undefined;
    if (label) map.set(row.id, label);
  }
  return map;
}
