/**
 * MCP Resources
 *
 * Exposes read-only data as MCP resources
 * Format: synap://{type}/{id} or synap://{type}
 */

import type { Resource } from "@modelcontextprotocol/sdk/types.js";

export const resources = {
  /**
   * List all available resources
   */
  async list(): Promise<Resource[]> {
    return [
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
    // Use adapter to call Hub Protocol API
    const { readMCPResourceViaHubProtocol } = await import("../adapter.js");
    return await readMCPResourceViaHubProtocol(uri, userId, apiKeyScopes);
  },
};
