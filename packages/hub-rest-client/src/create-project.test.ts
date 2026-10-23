/**
 * HubRestClient.createProject — every POST /api/hub/projects outcome.
 *
 * The pod answers 201 (row), 202 (proposed, with review link and, when a similar
 * project is why, `duplicateCheck`), 200 (deduped) and 400 (missing evidence).
 * A near match is no longer a 409 (FB1020 B2): the reviewer decides.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HubRestClient } from "./client.js";
import { HubApiError } from "./errors.js";

let reply: { status: number; body: unknown };
let client: HubRestClient;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
  client = new HubRestClient({
    podUrl: "https://pod.example.test",
    apiKey: "synap_hub_test_key",
    workspaceId: "ws-1",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProject", () => {
  it("a near match is FILED, not refused: the 202 carries its duplicateCheck", async () => {
    const duplicateCheck = {
      status: "possible",
      subject: "project",
      candidates: [
        {
          ref: "record",
          id: "p-9",
          kind: "project",
          title: "Atlas",
          why: "similar_name",
        },
      ],
    };
    reply = {
      status: 202,
      body: { status: "proposed", proposalId: "prop-2", duplicateCheck },
    };
    await expect(client.createProject({ name: "Atlas." })).resolves.toEqual({
      status: "proposed",
      proposalId: "prop-2",
      duplicateCheck,
    });
  });

  it("a 409 throws, whatever it carries", async () => {
    reply = { status: 409, body: { error: "conflict" } };
    await expect(
      client.createProject({ name: "Atlas" })
    ).rejects.toBeInstanceOf(HubApiError);
  });

  it("passes a proposed 202 through with its review link", async () => {
    reply = {
      status: 202,
      body: {
        status: "proposed",
        proposalId: "prop-1",
        reviewUrl: "https://pod.example.test/open/proposal/prop-1",
      },
    };
    await expect(
      client.createProject({ name: "Atlas" })
    ).resolves.toMatchObject({
      status: "proposed",
      reviewUrl: "https://pod.example.test/open/proposal/prop-1",
    });
  });

  it("throws the missing-evidence 400 as HubApiError", async () => {
    reply = { status: 400, body: { error: "needs 5 evidence entities" } };
    const err = await client.createProject({ name: "Atlas" }).catch((e) => e);
    expect(err).toBeInstanceOf(HubApiError);
    expect((err as HubApiError).statusCode).toBe(400);
  });

  it("does not stamp the client default workspace", async () => {
    reply = { status: 201, body: { id: "p-1", name: "Atlas" } };
    await client.createProject({ name: "Atlas" });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: "Atlas" });
  });
});
