/**
 * MCP Resources
 *
 * Exposes read-only data as MCP resources
 * Format: synap://{type}/{id} or synap://{type}
 */

import type { Resource } from "@modelcontextprotocol/sdk/types.js";

// Helper function to generate HTML for MCP App resources
function generateMcpAppHtml(kind: string, id: string): string {
  // Simple HTML that loads the embeddable UI from the apps route
  // This approach leverages the existing UI routes for rendering
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
  <style>
    body { margin: 0; height: 100vh; overflow: hidden; display: flex; justify-content: center; align-items: center; background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .loading { text-align: center; padding: 40px; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <div class="loading">Loading Synap ${kind}...</div>
  <iframe 
    src="/apps/${kind}/${id}?embed=1" 
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
        throw new Error(`Invalid UI resource URI: ${uri}`);
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
        throw new Error(`Invalid UI resource kind: ${kind}`);
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
