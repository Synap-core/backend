/**
 * Resolve the `/mcp` door serving a skill/brief from the acting key and agent —
 * what the pod already stamped when it minted the key. No door header: the
 * siblings need no change for the pod to know who is reading.
 *
 * The Synap account connector (the Control Plane, `pod__*` names) is told by
 * its KEY since W5: every key it holds carries the Synap account origin
 * (0400), whichever client's agent it belongs to (`chatgpt`, `generic`…:
 * services/synap-account-client.ts). Without a key, the agent decides, as
 * before (`claude-web` = the connector).
 *
 * A missing agent or key row is an EMPTY fact (pod names); a failed read
 * throws — it is never folded into "pod MCP".
 */

import { apiKeys, db, eq, users } from "@synap/database";

import { isSynapAccountKey } from "../synap-account-client.js";
import { skillDoorFor, type SkillDoor } from "./door-tool-render.js";

export async function resolveSkillDoor(
  agentUserId: string | null | undefined,
  keyId?: string | null
): Promise<SkillDoor> {
  if (keyId) {
    const [key] = await db
      .select({ origin: apiKeys.origin })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);
    if (isSynapAccountKey({ origin: key?.origin ?? null })) {
      return "cp-connector";
    }
  }
  if (!agentUserId) return skillDoorFor(null);
  const [row] = await db
    .select({ agentType: users.agentType })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  return skillDoorFor(row?.agentType ?? null);
}
