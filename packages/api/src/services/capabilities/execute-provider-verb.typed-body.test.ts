/**
 * A declarative verb's body keeps its parameters' types (ticket 231020d4).
 *
 * Before, every `{{param}}` in a body went through `String(value)` and an
 * absent optional became `""`, so a Hetzner verb could not send `ssh_keys`
 * (an array) or `labels` (an object), nor leave an optional field out. Now a
 * string that is EXACTLY one token carries the raw value, an absent one drops
 * its key, and a string mixing text and tokens stays a string.
 *
 * Driven through the real request builder (`buildProviderRequest`, the seam
 * the run and the dry-run preview share), REST body and GraphQL variables.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: vi.fn(),
}));

import { buildProviderRequest } from "./execute-provider-verb.js";
import type { ProviderVerbSpec } from "@synap/database/schema";

const createServer: ProviderVerbSpec = {
  tool: "hcloud",
  method: "POST",
  pathTemplate: "/v1/servers",
  body: {
    name: "{{name}}",
    server_type: "{{serverType}}",
    ssh_keys: "{{sshKeys}}",
    labels: "{{labels}}",
    start_after_create: "{{start}}",
    user_data: "{{userData}}",
    note: "server {{name}} ({{serverType}})",
    networks: ["{{networkId}}", "{{backupNetworkId}}"],
  },
  paramMapping: { name: { required: true } },
};

describe("buildProviderRequest — a whole-value token keeps its type", () => {
  it("arrays, objects, numbers and booleans arrive as themselves", () => {
    const { body } = buildProviderRequest(createServer, {
      name: "web-1",
      serverType: "cx22",
      sshKeys: [101, 102],
      labels: { env: "prod" },
      start: false,
      userData: null,
      networkId: 7,
      backupNetworkId: 8,
    });
    expect(body).toEqual({
      name: "web-1",
      server_type: "cx22",
      ssh_keys: [101, 102],
      labels: { env: "prod" },
      start_after_create: false,
      user_data: null,
      note: "server web-1 (cx22)",
      networks: [7, 8],
    });
  });

  it("an absent optional leaves its key (or array element) out; a mixed string stays a string", () => {
    const { body } = buildProviderRequest(createServer, {
      name: "web-1",
      networkId: 7,
    });
    expect(body).toEqual({
      name: "web-1",
      note: "server web-1 ()",
      networks: [7],
    });
  });

  it("a default from paramMapping still fills an absent param", () => {
    const { body } = buildProviderRequest(
      {
        ...createServer,
        body: { location: "{{location}}" },
        paramMapping: { location: { default: "fsn1" } },
      },
      {}
    );
    expect(body).toEqual({ location: "fsn1" });
  });

  it("GraphQL variables follow the same rule", () => {
    const { body } = buildProviderRequest(
      {
        tool: "t",
        method: "POST",
        pathTemplate: "/graphql",
        transport: "graphql",
        graphql: {
          query: "mutation M($ids: [ID!], $limit: Int) { m(ids: $ids) }",
          variables: { ids: "{{ids}}", limit: "{{limit}}" },
        },
      },
      { ids: ["a", "b"] }
    );
    expect((body as { variables: unknown }).variables).toEqual({
      ids: ["a", "b"],
    });
  });
});
