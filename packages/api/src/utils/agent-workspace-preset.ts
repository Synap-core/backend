/**
 * The agent-workspace preset: the keys provisioning stamps on an agent-owned
 * workspace. Applied on every (re-)provision, because a workspace created
 * before the preset existed must be fixed too.
 *
 * MERGED into the stored settings, never a replace. The blob also carries keys
 * the owner or the Control Plane set (the sharing policy, `controlPlane`, …);
 * a replace used to erase them, which silently reset the owner's sharing
 * policy to the permissive default.
 */

import { eq, drizzleSql, workspaces } from "@synap/database";

export function agentWorkspacePresetSettings(agentUserId: string) {
  return {
    workspaceType: "agent",
    linkedAgentId: agentUserId,
    governanceMode: "standard",
  };
}

export async function applyAgentWorkspacePreset(
  // The drizzle handle; typed loosely so a PGlite test can pass its own.
  database: { update: (table: typeof workspaces) => any },
  workspaceId: string,
  agentUserId: string
): Promise<void> {
  const preset = agentWorkspacePresetSettings(agentUserId);
  await database
    .update(workspaces)
    .set({
      workspaceType: "agent",
      settings: drizzleSql`coalesce(${workspaces.settings}, '{}'::jsonb) || ${JSON.stringify(preset)}::jsonb`,
    })
    .where(eq(workspaces.id, workspaceId));
}
