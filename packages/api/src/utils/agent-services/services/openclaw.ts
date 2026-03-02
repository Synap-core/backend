import type { ServiceCatalogEntry } from "../types.js";

export const openclawEntry: ServiceCatalogEntry = {
  serviceType: "openclaw",
  displayName: "OpenClaw",
  description:
    "OpenClaw world-interface agent (shell, browser, filesystem, messaging)",
  dockerImage: "ghcr.io/openclaw/openclaw:latest",
  agentRole: "editor",
  defaultScopes: [
    "hub-protocol.read",
    "hub-protocol.write",
    "mcp.read",
    "mcp.write",
  ],
  matchCapability: "channels",
  agentCapabilities: [
    "shell",
    "browser",
    "filesystem",
    "messaging",
    "channels",
  ],
  buildDockerCommand({ podUrl, workspaceId, agentUserId, apiKey }) {
    const shortId = workspaceId.slice(0, 8);
    return [
      "docker run -d",
      `  --name openclaw-${shortId}`,
      `  -e SYNAP_POD_URL="${podUrl}"`,
      `  -e SYNAP_HUB_API_KEY="${apiKey}"`,
      `  -e SYNAP_WORKSPACE_ID="${workspaceId}"`,
      `  -e SYNAP_AGENT_USER_ID="${agentUserId}"`,
      "  ghcr.io/openclaw/openclaw:latest",
    ].join(" \\\n");
  },
};
