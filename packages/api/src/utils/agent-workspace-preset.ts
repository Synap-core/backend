/**
 * The agent-workspace preset: the keys provisioning stamps on an agent's
 * workspace (owned by its person). Applied on every (re-)provision, because a
 * workspace created before the preset existed must be fixed too. It never
 * stamps `governanceMode`: that is the person's dial (absent = standard), and
 * a re-provision must not loosen what they tightened.
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
