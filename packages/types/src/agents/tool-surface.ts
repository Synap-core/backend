/**
 * The MCP tool surface a key LISTS (V1 D4): its profile and, on an `entry`
 * key, the deeper groups unlocked on it. ONE list for every reader:
 *   - the pod's `api_keys.tool_profile` (`API_KEY_TOOL_PROFILES` re-exports
 *     {@link MCP_TOOL_PROFILES});
 *   - the pod's MCP tool groups (`routers/mcp/tool-profiles.ts` declares
 *     `TOOL_GROUPS` as a record over {@link MCP_TOOL_GROUP_NAMES}, so a group
 *     cannot be added or dropped in one place only);
 *   - an agent template's starting surface (`spec.toolProfile`,
 *     `spec.toolGroups`, `agent-template.ts`), which the catalog mirrors.
 *
 * Pure, no imports: loaded by Node, Electron and React Native alike.
 */

/** `entry` = the essential tools, more in groups; `builder` = every tool. */
export const MCP_TOOL_PROFILES = ["entry", "builder"] as const;
export type McpToolProfile = (typeof MCP_TOOL_PROFILES)[number];

/** The deeper tool groups an `entry` key unlocks (`tools:<group>`). */
export const MCP_TOOL_GROUP_NAMES = [
  "read",
  "data",
  "sessions",
  "governance",
  "schema",
  "spaces",
  "tracks",
  "build",
  "capabilities",
] as const;
export type McpToolGroupName = (typeof MCP_TOOL_GROUP_NAMES)[number];
