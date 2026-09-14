/**
 * Resolve the door serving a skill/brief from the acting agent's identity — the
 * `agentType` the pod already stamped when it minted the key (`claude-web` for the
 * CP connector, `raycast` for `synap connect --target=raycast`). No door header:
 * the siblings need no change for the pod to know who is reading.
 *
 * A missing agent row is an EMPTY fact (source naming for that transport); a failed
 * read throws — it is never folded into "pod MCP".
 */

import { db, eq, users } from "@synap/database";

import { skillDoorFor, type SkillDoor } from "./door-tool-render.js";

export async function resolveSkillDoor(
  transport: "mcp" | "hub",
  agentUserId: string | null | undefined
): Promise<SkillDoor | null> {
  if (!agentUserId) return skillDoorFor(transport, null);
  const [row] = await db
    .select({ agentType: users.agentType })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  return skillDoorFor(transport, row?.agentType ?? null);
}
