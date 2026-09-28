/**
 * HubRestClient space-operation methods — driven against the wire the Hub
 * rest/workspace-ops.ts routes answer. Asserts what the caller receives: the
 * right verb+path+body reaches the pod, and a 202 `proposed` resolves (it is a
 * success, never an error).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubRestClient } from "./client.js";

type Reply = { status: number; body: unknown };
let replies: Reply[];
let calls: Array<{ url: string; method: string; body: unknown }>;
let client: HubRestClient;

beforeEach(() => {
  replies = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const reply = replies.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  client = new HubRestClient({
    podUrl: "https://pod.example.test",
    apiKey: "synap_hub_test_key",
    maxAttempts: 1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const WS = "22222222-2222-4222-8222-222222222222";
const PROPOSED = {
  status: "proposed",
  proposalId: "prop-1",
  reviewUrl: "https://pod.example.test/open/prop-1",
};

describe("archiveWorkspace", () => {
  it("POSTs /archive and resolves a 202 proposal", async () => {
    replies.push({ status: 202, body: PROPOSED });
    const out = await client.archiveWorkspace(WS, { reasoning: "retired" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `https://pod.example.test/api/hub/workspaces/${WS}/archive`
    );
    expect(calls[0].body).toEqual({ reasoning: "retired" });
    expect(out).toEqual(PROPOSED);
  });

  it("restore:true hits /restore, not /archive", async () => {
    replies.push({ status: 200, body: { status: "restored" } });
    await client.archiveWorkspace(WS, { restore: true });
    expect(calls[0].url).toBe(
      `https://pod.example.test/api/hub/workspaces/${WS}/restore`
    );
  });
});

describe("renameWorkspace", () => {
  it("PATCHes the space with name/description only", async () => {
    replies.push({ status: 202, body: PROPOSED });
    await client.renameWorkspace(WS, { name: "Sales" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(
      `https://pod.example.test/api/hub/workspaces/${WS}`
    );
    expect(calls[0].body).toEqual({ name: "Sales" });
  });
});

describe("moveEntities", () => {
  it("POSTs /entities/move and returns the per-entity ledger untouched", async () => {
    const ledger = {
      moved: ["e-1"],
      proposed: [{ entityId: "e-2", proposalId: "prop-2" }],
      errors: [{ entityId: "e-3", error: "Entity not found" }],
    };
    replies.push({ status: 200, body: ledger });
    const out = await client.moveEntities({
      entityIds: ["e-1", "e-2", "e-3"],
      workspaceId: WS,
      reason: "mis-routed",
    });
    expect(calls[0].url).toBe("https://pod.example.test/api/hub/entities/move");
    expect(calls[0].body).toEqual({
      entityIds: ["e-1", "e-2", "e-3"],
      workspaceId: WS,
      reason: "mis-routed",
    });
    expect(out).toEqual(ledger);
  });
});

describe("grantProfileAccess", () => {
  it("POSTs /profiles/grant-access", async () => {
    replies.push({ status: 202, body: { ...PROPOSED, success: false } });
    const out = await client.grantProfileAccess({
      profileId: "pr-1",
      targetWorkspaceId: WS,
    });
    expect(calls[0].url).toBe(
      "https://pod.example.test/api/hub/profiles/grant-access"
    );
    expect(calls[0].body).toEqual({ profileId: "pr-1", targetWorkspaceId: WS });
    expect(out.status).toBe("proposed");
  });
});
