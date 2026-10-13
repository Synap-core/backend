/**
 * The large-file lane at the MCP door (D10/L1): `synap_request_upload` and
 * `synap_store_file({uploadToken})`.
 *
 * Drives the REAL handlers; the `agent-upload` service (its token, presign and
 * finalize have their own suite) is the only thing replaced. Pins the SEAM:
 * the confined workspace, the agent identity, the key type and the session
 * reach the service; a refusal comes back as an error carrying its words;
 * `ok` never leaks; a token never mixes with inline bytes; and the token
 * path does not count against the inline rate limit twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  finals: [] as Array<Record<string, unknown>>,
  rateLimited: 0,
  requestAnswer: null as null | Record<string, unknown>,
}));

vi.mock("../../../services/files/agent-upload.js", () => ({
  requestAgentUpload: async (p: Record<string, unknown>) => {
    h.requests.push(p);
    return h.requestAnswer;
  },
  finalizeAgentUpload: async (p: Record<string, unknown>) => {
    h.finals.push(p);
    return {
      ok: true,
      status: "created",
      fileEntityId: "f-1",
      documentId: "d-1",
    };
  },
}));
vi.mock("../../../utils/hub-protocol-rate-limit.js", () => ({
  checkHubRateLimit: () => {
    h.rateLimited++;
  },
}));

import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "55555555-1111-4111-8111-111111111111";

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "agent-1",
    sessionId: SESSION,
    keyType: "agent",
    keyWorkspaceId: WS,
    requestedWorkspaceId: WS,
  } as unknown as McpToolContext;
}

const parse = (r: unknown) =>
  JSON.parse(
    (r as { content: Array<{ text: string }> }).content[0]!.text
  ) as Record<string, unknown>;

beforeEach(() => {
  h.requests = [];
  h.finals = [];
  h.rateLimited = 0;
  h.requestAnswer = {
    ok: true,
    uploadUrl: "https://s3/put",
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    uploadToken: "tok",
    expiresAt: "2026-10-13T16:00:00.000Z",
    maxBytes: 500,
  };
});

describe("synap_request_upload", () => {
  it("forwards the confined workspace, agent, session and exact size; strips `ok`", async () => {
    const out = parse(
      await entityHandlers.synap_request_upload!(
        ctx("synap_request_upload", {
          filename: " launch.mp4 ",
          mimeType: "video/mp4",
          size: 123456,
        })
      )
    );
    expect(h.requests).toEqual([
      {
        userId: "user-1",
        agentUserId: "agent-1",
        workspaceId: WS,
        filename: "launch.mp4",
        mimeType: "video/mp4",
        size: 123456,
        sessionId: SESSION,
      },
    ]);
    expect(out.uploadToken).toBe("tok");
    expect(out).not.toHaveProperty("ok");
  });

  it("a refusal is an error in the service's words", async () => {
    h.requestAnswer = {
      ok: false,
      status: 415,
      code: "MIME_NOT_ALLOWED",
      error: "MIME type not allowed: application/x-msdownload",
    };
    await expect(
      entityHandlers.synap_request_upload!(
        ctx("synap_request_upload", {
          filename: "a.exe",
          mimeType: "application/x-msdownload",
          size: 1,
        })
      )
    ).rejects.toThrow(/MIME type not allowed/);
  });
});

describe("synap_store_file({uploadToken})", () => {
  it("finalizes through the service with the key's identity, skipping the inline limiter", async () => {
    const out = parse(
      await entityHandlers.synap_store_file!(
        ctx("synap_store_file", {
          uploadToken: " tok ",
          title: "Launch video",
          expectedLabel: "Launch video (mp4)",
        })
      )
    );
    expect(h.finals).toEqual([
      {
        userId: "user-1",
        agentUserId: "agent-1",
        scopes: ["mcp.read", "mcp.write"],
        keyType: "agent",
        keyWorkspaceId: WS,
        uploadToken: "tok",
        title: "Launch video",
        sessionId: SESSION,
        expectedLabel: "Launch video (mp4)",
      },
    ]);
    expect(h.rateLimited).toBe(0);
    expect(out).toMatchObject({
      status: "created",
      fileEntityId: "f-1",
      documentId: "d-1",
    });
    expect(out).not.toHaveProperty("ok");
  });

  it("refuses a token together with inline content", async () => {
    await expect(
      entityHandlers.synap_store_file!(
        ctx("synap_store_file", { uploadToken: "tok", content: "hi" })
      )
    ).rejects.toThrow(/not both/);
    expect(h.finals).toHaveLength(0);
  });
});
