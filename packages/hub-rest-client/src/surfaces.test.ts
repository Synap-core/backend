/**
 * The surface write methods (Surfaces P3) reach the three Hub routes with
 * the body the pod reads: POST /surfaces, POST /surfaces/attach, and DELETE
 * /surfaces/attach WITH its body (a DELETE whose body is dropped would detach
 * nothing and 400).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubRestClient } from "./client.js";

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({ status: "proposed", proposalId: "p-1" }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }
      );
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new HubRestClient({
    podUrl: "https://pod.example.test",
    apiKey: "synap_hub_test_key",
  });
const anchor = { kind: "project" as const, id: "p-uuid" };
const surface = { type: "view" as const, id: "v-uuid" };

describe("surface writes", () => {
  it("createSurface posts the anchor, body, title and spec", async () => {
    const res = await client().createSurface({
      anchor,
      body: "bento",
      title: "Investor radar",
      spec: { config: { blocks: [] } },
    });
    expect(res).toEqual({ status: "proposed", proposalId: "p-1" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://pod.example.test/api/hub/surfaces",
      body: { anchor, body: "bento", title: "Investor radar" },
    });
  });

  it("attachSurface and detachSurface reach /surfaces/attach, the DELETE with its body", async () => {
    await client().attachSurface({ anchor, surface, label: "Radar" });
    await client().detachSurface({ anchor, surface });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://pod.example.test/api/hub/surfaces/attach"],
      ["DELETE", "https://pod.example.test/api/hub/surfaces/attach"],
    ]);
    expect(calls[0]!.body).toMatchObject({ anchor, surface, label: "Radar" });
    expect(calls[1]!.body).toMatchObject({ anchor, surface });
  });
});
