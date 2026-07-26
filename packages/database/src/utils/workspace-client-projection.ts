/**
 * Client-safe workspace projection.
 *
 * Workspace settings is an open JSONB document and may contain credential
 * containers written by server-only integrations. Every user-facing workspace
 * row and every persisted/broadcast workspace event must pass through this
 * allowlist.
 */

export const CLIENT_SAFE_WORKSPACE_SETTINGS_KEYS = [
  // Workspace directory / capability source contract.
  "workspaceSubtype",
  "onboarding",
  "workspaceVisibility",
  "workspaceCapabilities",
  "sourceRoles",
  "defaultSources",
  "appId",
  "packageSlug",
  "systemSlug",
  // UI layout / view-id caches.
  "layout",
  "mainWhiteboardId",
  "profileBentoViewIds",
  "profileEntityBentoTemplates",
  "profileRenderers",
  "sidebarItems",
  "installedPacks",
  // Agent / governance configuration surfaced in settings.
  "intelligenceServiceId",
  "agentPersonality",
  "agentModelPreferences",
  "governanceMode",
  "aiGovernance",
  "proactiveAi",
  // App-specific, non-sensitive values.
  "devplane",
  "crm_4_entity_migration_v1",
  "proposalId",
] as const;

const CLIENT_SAFE_WORKSPACE_SETTINGS_SUBKEYS: Record<
  string,
  readonly string[]
> = {
  // `devplane.userProviders` contains per-user vault references and must never
  // leave the server. Only the presentation flag is client-readable.
  devplane: ["localTerminalEnabled"],
};

/**
 * Replace a workspace-like row's settings with the client-safe allowlist.
 * The input is never mutated.
 */
export function projectWorkspaceSettings<T extends { settings?: unknown }>(
  workspace: T
): T {
  const raw = workspace.settings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...workspace, settings: {} };
  }

  const source = raw as Record<string, unknown>;
  const safe: Record<string, unknown> = {};

  for (const key of CLIENT_SAFE_WORKSPACE_SETTINGS_KEYS) {
    if (!(key in source)) continue;

    const leaves = CLIENT_SAFE_WORKSPACE_SETTINGS_SUBKEYS[key];
    const value = source[key];
    if (leaves && value && typeof value === "object" && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const leaf of leaves) {
        if (leaf in inner) picked[leaf] = inner[leaf];
      }
      safe[key] = picked;
      continue;
    }

    safe[key] = value;
  }

  return { ...workspace, settings: safe };
}
