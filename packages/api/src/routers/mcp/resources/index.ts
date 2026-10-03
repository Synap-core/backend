/**
 * MCP Resources
 *
 * Exposes read-only data as MCP resources
 * Format: synap://{type}/{id} or synap://{type}
 */

import type { Resource } from "@modelcontextprotocol/sdk/types.js";

// Helper function to generate HTML for MCP App resources
function generateMcpAppHtml(kind: string, id: string): string {
  // The iframe src is now an ABSOLUTE URL (set by the /apps/:kind/:id route in apps/api)
  // We need to know the pod's PUBLIC_URL. Since this runs in the MCP handler context,
  // we don't have direct access to config. We'll construct it from the standard env var.
  // This HTML is served by the MCP server and rendered in an MCP client — the iframe
  // src MUST be absolute so it works regardless of where the MCP client renders it.
  const baseUrl = process.env.PUBLIC_URL || `http://localhost:4000`;
  const appUrl = `${baseUrl}/apps/${kind}/${id}?embed=1`;

  // CSP for secure iframe embedding
  // Matches the CSP in generateAppSrcdoc in apps/api/src/index.ts
  const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; connect-src 'self' https://pod-admin.*.synap.live https://*.thearch.synap.live; form-action 'self'; base-uri 'none'; frame-ancestors 'self' https://pod-admin.*.synap.live https://*.thearch.synap.live; object-src 'none'";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    body { margin: 0; height: 100vh; overflow: hidden; display: flex; justify-content: center; align-items: center; background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .loading { text-align: center; padding: 40px; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <div class="loading">Loading Synap ${kind}...</div>
  <iframe
    src="${appUrl}"
    sandbox="allow-scripts allow-same-origin"
    allow="synap-widget"
  ></iframe>
</body>
</html>`;
}

export const resources = {
  /**
   * List all available resources
   */
  async list(): Promise<Resource[]> {
    const baseResources = [
      {
        uri: "synap://entities/tasks",
        name: "All Tasks",
        description: "All tasks in Synap",
        mimeType: "application/json",
      },
      {
        uri: "synap://entities/contacts",
        name: "All Contacts",
        description: "All contacts in Synap",
        mimeType: "application/json",
      },
      {
        uri: "synap://entities/projects",
        name: "All Projects",
        description: "All projects in Synap",
        mimeType: "application/json",
      },
      {
        uri: "synap://entities/notes",
        name: "All Notes",
        description: "All notes in Synap",
        mimeType: "application/json",
      },
      // Individual entity resources are dynamic (synap://entities/{type}/{id})
      // Document resources are dynamic (synap://documents/{id})
      // Thread resources are dynamic (synap://threads/{id}/context)
    ];

    // Add dynamic UI resources for MCP Apps surface
    const uiResources = [
      {
        kind: "entity",
        name: "Entity App",
        description: "Render an entity as an embeddable app",
      },
      {
        kind: "view",
        name: "View App",
        description: "Render a view as an embeddable app",
      },
      {
        kind: "proposal",
        name: "Proposal App",
        description: "Render a proposal as an embeddable app",
      },
      {
        kind: "session",
        name: "Session App",
        description: "Render a session as an embeddable app",
      },
      {
        kind: "channel",
        name: "Channel App",
        description: "Render a channel as an embeddable app",
      },
    ];

    const uiResourceTemplates = uiResources.flatMap(
      ({ kind, name, description }) => [
        {
          uri: `ui://synap/${kind}/*`,
          name: `${name} Template`,
          description: description,
          mimeType: "text/html;profile=mcp-app",
        },
      ]
    );

    return [...baseResources, ...uiResourceTemplates];
  },

  /**
   * Read a resource by URI
   *
   * Uses Hub Protocol API to ensure all operations go through
   * proper security, validation, and data access patterns
   */
  async read(
    uri: string,
    userId: string,
    apiKeyScopes: string[]
  ): Promise<{
    contents: Array<{
      uri: string;
      mimeType: string;
      text?: string;
      blob?: string;
    }>;
  }> {
    // Handle UI resources: ui://synap/<kind>/<id>
    if (uri.startsWith("ui://synap/")) {
      const match = uri.match(/^ui:\/\/synap\/(\w+)\/(.+)$/);
      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const [, kind, id] = match;
      const validKinds = [
        "entity",
        "view",
        "proposal",
        "session",
        "channel",
      ] as const;

      if (!validKinds.includes(kind as any)) {
        throw new Error(`Invalid kind: ${kind}`);
      }

      // For UI resources, we return HTML that will be rendered in an iframe
      // This HTML loads the actual UI from the /apps/<kind>/<id> endpoint
      return {
        contents: [
          {
            uri,
            mimeType: "text/html;profile=mcp-app",
            text: generateMcpAppHtml(kind, id),
          },
        ],
      };
    }

    // Use adapter to call Hub Protocol API for non-UI resources
    const { readMCPResourceViaHubProtocol } = await import("../adapter.js");
    return await readMCPResourceViaHubProtocol(uri, userId, apiKeyScopes);
  },
};
