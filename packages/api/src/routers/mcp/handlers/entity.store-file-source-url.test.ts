/**
 * `synap_store_file({sourceUrl})`: the pod downloads a URL into a pod file
 * (agent report 630ff4f7: a generated image, held only as a URL, could not
 * become a file an agent attaches to a post).
 *
 * Drives the REAL handler through the REAL `fetchUrlFile` and the shared
 * remote-bytes door (`fetchGuardedBytes`); only the socket is faked:
 * `safePublicFetch` records what it was asked for. That the door refuses a
 * plain-http hop and every private address is `pinned-fetch.test.ts`'s proof;
 * this proves THIS door asks for it (`httpsOnly`, the redirect budget) and that
 * the downloaded bytes, type and name reach the governed store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  fetches: [] as Array<{
    url: string;
    maxRedirects: unknown;
    deps: Record<string, unknown> | undefined;
  }>,
  respond: (() => new Response("x")) as (url: string) => Response,
  stores: [] as Array<Record<string, unknown>>,
  creates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safePublicFetch: async (
    url: string,
    _init: unknown,
    maxRedirects: unknown,
    deps?: Record<string, unknown>
  ) => {
    h.fetches.push({ url, maxRedirects, deps });
    return h.respond(url);
  },
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ProfileResolutionService: class {
    getEntityScope = async () => "pod";
  },
  getWorkspaceMembership: async () => null,
}));
vi.mock("../../file-upload.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeDocumentFromBuffer: async (p: Record<string, unknown>) => {
    h.stores.push(p);
    return {
      documentId: `doc-${String(p.filename)}`,
      storageKey: `files/${String(p.filename)}`,
      storageUrl: "u",
      size: 4,
      document: { id: `doc-${String(p.filename)}` },
    };
  },
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.creates.push(input);
        return { id: "ent-1" };
      },
    }),
  },
}));
vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../../utils/hub-protocol-rate-limit.js", () => ({
  checkHubRateLimit: () => undefined,
}));
vi.mock("../../../services/focus-sessions/record-session-artifact.js", () => ({
  recordSessionArtifact: async () => undefined,
}));

import { BlockedOutboundError } from "@synap/shared-utils";
import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const WS = "11111111-1111-4111-8111-111111111111";
const IMAGE = "https://v3.fal.media/files/zebra/out%20one.png?sig=abc";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_store_file",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "agent-1",
    sessionId: undefined,
    requestedWorkspaceId: WS,
  } as unknown as McpToolContext;
}

const store = entityHandlers.synap_store_file!;

beforeEach(() => {
  h.fetches = [];
  h.stores = [];
  h.creates = [];
  h.respond = () =>
    new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
});

describe("synap_store_file({sourceUrl}) downloads the URL into a pod file", () => {
  it("THE FILED CASE: a generated image URL becomes a file, its bytes, type and name kept", async () => {
    await store(ctx({ sourceUrl: IMAGE }));
    // Through the pinned door, https on EVERY hop, within the redirect budget.
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0]!.url).toBe(IMAGE);
    expect(h.fetches[0]!.deps).toEqual({ httpsOnly: true });
    expect(h.fetches[0]!.maxRedirects).toBe(3);
    // The bytes reached the store as served: type from the server, name from the URL.
    expect(h.stores).toHaveLength(1);
    expect(Buffer.compare(h.stores[0]!.buffer as Buffer, PNG)).toBe(0);
    expect(h.stores[0]!.mimeType).toBe("image/png");
    expect(h.stores[0]!.filename).toBe("out one.png");
    expect(h.creates).toHaveLength(1);
  });

  it("refuses a plain-http URL before any request", async () => {
    await expect(
      store(ctx({ sourceUrl: "http://v3.fal.media/files/out.png" }))
    ).rejects.toThrow(/https URL/);
    expect(h.fetches).toHaveLength(0);
    expect(h.stores).toHaveLength(0);
  });

  it("a hop the door refuses (a private address, a redirect off https) stores nothing", async () => {
    h.respond = () => {
      throw new BlockedOutboundError("resolves to a private address");
    };
    await expect(store(ctx({ sourceUrl: IMAGE }))).rejects.toThrow(
      /not allowed \(only public https addresses/
    );
    expect(h.stores).toHaveLength(0);
  });

  it("refuses a file past the 10MB cap from its Content-Length", async () => {
    h.respond = () =>
      new Response(PNG, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(11 * 1024 * 1024),
        },
      });
    await expect(store(ctx({ sourceUrl: IMAGE }))).rejects.toThrow(
      /larger than the store accepts/
    );
    expect(h.stores).toHaveLength(0);
  });

  it("checks the served type: it must match a declared one and be allowed", async () => {
    await expect(
      store(ctx({ sourceUrl: IMAGE, mimeType: "application/pdf" }))
    ).rejects.toThrow(/serves image\/png, not the declared application\/pdf/);
    h.respond = () =>
      new Response("MZ", {
        status: 200,
        headers: { "content-type": "application/x-msdownload" },
      });
    await expect(store(ctx({ sourceUrl: IMAGE }))).rejects.toThrow(
      /MIME type not allowed: application\/x-msdownload/
    );
    expect(h.stores).toHaveLength(0);
  });

  it("takes exactly one source", async () => {
    await expect(
      store(ctx({ sourceUrl: IMAGE, content: "hi", filename: "a.txt" }))
    ).rejects.toThrow(/exactly one of/);
    expect(h.fetches).toHaveLength(0);
  });
});
