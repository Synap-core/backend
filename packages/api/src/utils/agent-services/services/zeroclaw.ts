import type { ServiceCatalogEntry } from "../types.js";

export const zeroclawEntry: ServiceCatalogEntry = {
  serviceType: "zeroclaw",
  displayName: "ZeroClaw",
  description: "ZeroClaw LLM inference agent",
  dockerImage: "ghcr.io/zeroclaw/zeroclaw:latest",
  agentRole: "editor",
  defaultScopes: [
    "hub-protocol.read",
    "hub-protocol.write",
    "mcp.read",
    "mcp.write",
  ],
  matchCapability: "llm",
  agentCapabilities: ["llm", "inference"],
  buildDockerCommand({ podUrl, workspaceId, agentUserId, apiKey }) {
    const shortId = workspaceId.slice(0, 8);
    return [
      "docker run -d",
      `  --name zeroclaw-${shortId}`,
      `  -e SYNAP_POD_URL="${podUrl}"`,
      `  -e SYNAP_HUB_API_KEY="${apiKey}"`,
      `  -e SYNAP_WORKSPACE_ID="${workspaceId}"`,
      `  -e SYNAP_AGENT_USER_ID="${agentUserId}"`,
      "  ghcr.io/zeroclaw/zeroclaw:latest",
    ].join(" \\\n");
  },
};
