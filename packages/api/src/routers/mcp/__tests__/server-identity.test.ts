/**
 * What an MCP client shows for a pod's connector: the REAL `createMCPServer`
 * over the SDK's in-memory transport, read back through `initialize`'s
 * `serverInfo` (name, title, website and the amber S icons, brand-icons.ts).
 * Stubbed: the database and the agent focus lookup only, as in
 * ui-resources-contract.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
}));
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/agent-identity-service.js")
  >()),
  getAgentFocusWorkspaceId: vi.fn(async () => undefined),
}));

const { createMCPServer } = await import("../index.js");
const { SYNAP_MARK_SVG } = await import("../../../brand-icons.js");

describe("the pod MCP server's identity", () => {
  it("initialize names it Synap, with the website and the amber S icons", async () => {
    const server = createMCPServer(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111"
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);

    const info = client.getServerVersion();
    expect(info?.name).toBe("synap-mcp-server");
    expect(info?.title).toBe("Synap");
    expect(info?.websiteUrl).toBe("https://www.synap.live");
    // Data URIs only: an MCP client must not fetch an icon from another origin.
    const icons = info?.icons ?? [];
    expect(icons.map((i) => [i.mimeType, i.sizes])).toEqual([
      ["image/png", ["64x64"]],
      ["image/svg+xml", ["any"]],
    ]);
    for (const icon of icons)
      expect(icon.src).toMatch(/^data:image\/(png|svg\+xml);base64,/);
    const png = Buffer.from(icons[0].src.split(",")[1], "base64");
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(Buffer.from(icons[1].src.split(",")[1], "base64").toString()).toBe(
      SYNAP_MARK_SVG
    );
    await client.close();
  });
});
