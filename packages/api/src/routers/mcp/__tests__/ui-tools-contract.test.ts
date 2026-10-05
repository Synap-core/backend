/**
 * MCP Apps contract (SEP-1865) — `_meta.ui` on `tools/list`, and
 * `structuredContent` on a UI-tagged tool's result.
 *
 * Driven through the REAL MCP `Server` (`createMCPServer`) over the SDK's
 * in-memory transport for `tools/list`, and through the REAL dispatcher
 * (`executeMCPToolViaHubProtocol` → real `synap_get_proposal` handler → real
 * `ok()`) for results. Stubbed: the DB-backed proposal read and the caller
 * factories only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const PROPOSAL_ID = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  /** When set, `resolveSessionHandle` reports this attribution. */
  attribution: null as Record<string, unknown> | null,
}));

vi.mock("../handlers/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handlers/shared.js")>();
  return {
    ...actual,
    createHubProtocolCaller: vi.fn(async () => ({
      context: { getThreadContext: async () => ({ id: "t-1", messages: [] }) },
    })),
    resolveSessionHandle: vi.fn(async () =>
      h.attribution
        ? { session: undefined, attribution: h.attribution }
        : undefined
    ),
  };
});
vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  resolveProposalId: vi.fn(async (_u: string, raw: string) => raw),
  verifyWorkspaceAccess: vi.fn(async () => false),
}));
vi.mock("../../hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hub-protocol/utils.js")>()),
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../../proposals.js", () => ({
  proposalsRouter: {
    createCaller: () => ({ get: async () => h.row }),
  },
}));
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/agent-identity-service.js")
  >()),
  getAgentFocusWorkspaceId: vi.fn(async () => undefined),
}));

const { executeMCPToolViaHubProtocol } = await import("../adapter.js");
const { createMCPServer } = await import("../index.js");
const { TOOL_UI_SUBJECT, UI_NOT_SERVABLE, withToolUiMeta } =
  await import("../ui-tools.js");
const { tools } = await import("../tools/index.js");

async function listVia(isUiServable?: (kind: string) => Promise<boolean>) {
  const server = createMCPServer(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "full",
    isUiServable
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const listed = await client.listTools();
  const caps = client.getServerCapabilities();
  await client.close();
  return { listed: listed.tools, caps };
}

beforeEach(() => {
  h.row = {
    id: PROPOSAL_ID,
    status: "pending",
    viewerCanReview: false,
  };
  h.attribution = null;
});

describe("tools/list — _meta.ui only when servable", () => {
  it("UNWIRED (default seam): tools/list equals the raw tool list, no _meta.ui anywhere", async () => {
    const { listed } = await listVia();
    const raw = await tools.list({ door: "chat" });
    // Non-vacuity: a real surface that contains the tagged tool.
    expect(listed.length).toBeGreaterThan(50);
    expect(listed.map((t) => t.name)).toContain("synap_get_proposal");
    expect(listed.filter((t) => t._meta && "ui" in t._meta)).toEqual([]);
    // Over the wire the client re-parses (key order may differ) — deep-equal.
    expect(listed).toEqual(raw);
    // At the seam itself: untouched tools are the SAME objects, not copies.
    const shaped = await withToolUiMeta(raw, UI_NOT_SERVABLE, {});
    shaped.forEach((t, i) => expect(t).toBe(raw[i]));
  });

  it("SERVABLE: the tagged tool carries the nested _meta.ui; untagged tools are untouched", async () => {
    const asked: string[] = [];
    const { listed } = await listVia(async (kind) => {
      asked.push(kind);
      return true;
    });
    const get = listed.find((t) => t.name === "synap_get_proposal");
    expect(get?._meta).toEqual({
      ui: {
        resourceUri: "ui://synap/proposal-card",
        visibility: ["model", "app"],
      },
    });
    // Never the legacy flat key.
    expect(get?._meta).not.toHaveProperty("ui/resourceUri");
    const tagged = listed.filter((t) => t._meta && "ui" in t._meta);
    expect(tagged.map((t) => t.name).sort()).toEqual(
      Object.keys(TOOL_UI_SUBJECT).sort()
    );
    expect(asked).toEqual(["proposal"]);
  });

  it("NOT SERVABLE for this kind: no _meta.ui", async () => {
    const { listed } = await listVia(async () => false);
    expect(listed.filter((t) => t._meta && "ui" in t._meta)).toEqual([]);
  });
});

async function call(toolName: string, args: Record<string, unknown>) {
  return (await executeMCPToolViaHubProtocol(toolName, args, "user-1", [
    "mcp.read",
  ])) as CallToolResult & { structuredContent?: Record<string, unknown> };
}

describe("structuredContent — tagged tools only, same payload as the text", () => {
  it("synap_get_proposal: structuredContent IS the JSON text payload, link included", async () => {
    const res = await call("synap_get_proposal", { proposalId: PROPOSAL_ID });
    const text = JSON.parse(
      (res.content[0] as { type: "text"; text: string }).text
    );
    expect(text.link).toEqual(expect.stringContaining(PROPOSAL_ID));
    expect(res.structuredContent).toEqual(text);
  });

  it("attribution stamped onto the text is in structuredContent too (they never diverge)", async () => {
    h.attribution = { session: "none", ambiguous: false, openCount: 0 };
    const res = await call("synap_get_proposal", { proposalId: PROPOSAL_ID });
    const text = JSON.parse(
      (res.content[0] as { type: "text"; text: string }).text
    );
    expect(text.attribution).toEqual(h.attribution);
    expect(res.structuredContent).toEqual(text);
  });

  it("an UNTAGGED tool gets no structuredContent", async () => {
    const res = await call("synap_get_thread_context", { threadId: "t-1" });
    // Non-vacuity: the untagged tool really returned an object payload.
    expect(
      JSON.parse((res.content[0] as { type: "text"; text: string }).text)
    ).toMatchObject({ id: "t-1" });
    expect(res.structuredContent).toBeUndefined();
  });

  it("a non-object (array) payload gets no structuredContent", async () => {
    (h as { row: unknown }).row = [{ id: PROPOSAL_ID }];
    const res = await call("synap_get_proposal", { proposalId: PROPOSAL_ID });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeUndefined();
  });
});
