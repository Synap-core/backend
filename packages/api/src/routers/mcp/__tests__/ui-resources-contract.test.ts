/**
 * MCP Apps — the WIRED renderer seam, end to end: `tools/list` `_meta.ui`,
 * `resources/list` and `resources/read` for `ui://synap/*`, all driven through
 * the REAL MCP `Server` (`createMCPServer`) over the SDK's in-memory transport
 * with the REAL lookup the HTTP door passes (`resolveUiRendererFromDb`).
 * Stubbed: `resolveSurfaceRenderer` at the `@synap/database` boundary only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  resolveSurfaceRenderer: h.resolve,
}));
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/agent-identity-service.js")
  >()),
  getAgentFocusWorkspaceId: vi.fn(async () => undefined),
}));

const { createMCPServer } = await import("../index.js");
const { resolveUiRendererFromDb, MCP_APP_MIME_TYPE, RESOURCE_NOT_FOUND } =
  await import("../ui-tools.js");

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const CARD = "ui://synap/proposal-card";
const SOURCE = "<!doctype html><html><body>proposal card</body></html>";

async function connect(scopes: string[] = ["mcp.read"]) {
  const server = createMCPServer(
    WS,
    USER,
    undefined,
    undefined,
    undefined,
    scopes,
    undefined,
    undefined,
    undefined,
    "full",
    resolveUiRendererFromDb
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

function servable(externalHosts: string[] = []) {
  h.resolve.mockResolvedValue({
    cellKey: "proposal-card",
    rendererSource: SOURCE,
    externalHosts,
    version: "1",
    bindingScope: "pod",
  });
}

const uiTools = (tools: Array<{ name: string; _meta?: object }>) =>
  tools.filter((t) => t._meta && "ui" in t._meta).map((t) => t.name);

beforeEach(() => {
  h.resolve.mockReset();
});

describe("SERVABLE — all three surfaces agree", () => {
  it("tools/list tags the tool, resources/list lists it, resources/read serves the source verbatim", async () => {
    servable(["https://api.example.com"]);
    const client = await connect();

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(50); // non-vacuity: the real surface
    expect(uiTools(tools)).toEqual(["synap_get_proposal"]);

    const { resources } = await client.listResources();
    expect(resources.filter((r) => r.uri.startsWith("ui://"))).toEqual([
      expect.objectContaining({
        uri: CARD,
        name: "proposal-card",
        mimeType: MCP_APP_MIME_TYPE,
      }),
    ]);
    // The synap:// resources are still there.
    expect(resources.some((r) => r.uri.startsWith("synap://"))).toBe(true);

    const read = await client.readResource({ uri: CARD });
    expect(read.contents).toEqual([
      {
        uri: CARD,
        mimeType: "text/html;profile=mcp-app",
        text: SOURCE,
        _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } },
      },
    ]);

    // The resolver is asked for the right thing: card slot, mcp-app surface,
    // the caller and the URL's workspace lens.
    expect(h.resolve).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      workspaceId: WS,
      subjectKind: "proposal",
      contentKind: "entity-card",
      surface: "mcp-app",
    });
    await client.close();
  });

  it("no external hosts → no csp at all", async () => {
    servable([]);
    const client = await connect();
    const read = await client.readResource({ uri: CARD });
    expect(read.contents[0]).toEqual({
      uri: CARD,
      mimeType: MCP_APP_MIME_TYPE,
      text: SOURCE,
    });
    await client.close();
  });
});

describe("NOT SERVABLE — none of the three", () => {
  it("no _meta.ui, no ui:// resource, read is resource-not-found", async () => {
    h.resolve.mockResolvedValue(null);
    const client = await connect();
    expect(uiTools((await client.listTools()).tools)).toEqual([]);
    const { resources } = await client.listResources();
    expect(resources.filter((r) => r.uri.startsWith("ui://"))).toEqual([]);
    expect(resources.length).toBeGreaterThan(0); // non-vacuity
    await expect(client.readResource({ uri: CARD })).rejects.toMatchObject({
      code: RESOURCE_NOT_FOUND,
    });
    await client.close();
  });
});

describe("RESOLVER THROWS", () => {
  it("tools/list still returns every tool, without _meta.ui; resources/list omits it", async () => {
    h.resolve.mockRejectedValue(new Error("db down"));
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("synap_get_proposal");
    expect(uiTools(tools)).toEqual([]);
    const { resources } = await client.listResources();
    expect(resources.filter((r) => r.uri.startsWith("ui://"))).toEqual([]);
    await client.close();
  });

  it("resources/read PROPAGATES the failure — never a not-found, never an empty document", async () => {
    h.resolve.mockRejectedValue(new Error("db down"));
    const client = await connect();
    const err = await client.readResource({ uri: CARD }).then(
      () => null,
      (e: { code?: number; message: string }) => e
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("db down");
    expect(err!.code).not.toBe(RESOURCE_NOT_FOUND);
    await client.close();
  });
});

describe("UNKNOWN ui:// URI", () => {
  it("is resource-not-found even when a renderer IS servable, and never reaches the resolver", async () => {
    servable();
    const client = await connect();
    await expect(
      client.readResource({ uri: "ui://synap/nope" })
    ).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND });
    expect(h.resolve).not.toHaveBeenCalled();
    await client.close();
  });

  it("without mcp.read, a ui:// read is refused before any lookup", async () => {
    servable();
    const client = await connect(["mcp.write"]);
    await expect(client.readResource({ uri: CARD })).rejects.toThrow(
      /mcp\.read required/
    );
    expect(h.resolve).not.toHaveBeenCalled();
    await client.close();
  });
});
