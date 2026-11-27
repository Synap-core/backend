/**
 * `synap_list_capabilities` says, on the `http.get_json` row, where it can
 * reach today: the pod's allow-list, read live (`readLiveVerbReach`), in the
 * review's reach shape (`ProposalPartReach`). Before, an agent learned the
 * list only from a refusal.
 *
 * The real handler and the real fold (`sectionCapabilities`); stubbed: the
 * registry's DB read (`listCapabilities`), the read floor (`canRead`) and the
 * allow-list's own DB read (`listAllowedHosts`), so the seam under test is
 * handler → live reach → row. A row the reach does not name carries none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYNAP_CORE_DEFINITION } from "../../../services/capabilities/ensure-synap-core.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const h = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  listAllowedHosts: vi.fn(),
}));

vi.mock(
  "../../../services/capabilities/capability-registry.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../services/capabilities/capability-registry.js")
    >()),
    listCapabilities: h.listCapabilities,
  })
);
vi.mock("../../../services/capabilities/http-get-json.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/capabilities/http-get-json.js")
  >()),
  listAllowedHosts: h.listAllowedHosts,
}));
vi.mock("../../../access/door.js", async (orig) => ({
  ...(await orig<typeof import("../../../access/door.js")>()),
  canRead: async () => true,
}));

const { capabilityHandlers } = await import("./capability.js");

function coreRow(name: string) {
  const def = SYNAP_CORE_DEFINITION.skills.find((s) => s.name === name);
  if (!def) throw new Error(`${name} is not a Synap Core verb`);
  return {
    kind: "skill" as const,
    id: `skill-${name}`,
    name,
    description: def.description ?? null,
    inputSchema: { type: "object", properties: {} },
    executor: "is-agent",
    governance: "none",
    enabled: true,
    containerId: "core",
    containerName: SYNAP_CORE_DEFINITION.name,
  };
}

async function listCaps(args: Record<string, unknown>) {
  const res = (await capabilityHandlers.synap_list_capabilities!({
    toolName: "synap_list_capabilities",
    args: { workspaceId: WS, ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    agentUserId: "agent-1",
  } as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text) as {
    skills: Array<{ name: string; reach?: unknown }>;
  };
}

describe("synap_list_capabilities: the http.get_json row says where it reaches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listCapabilities.mockResolvedValue([
      coreRow("http.get_json"),
      coreRow("http.allow_host"),
    ]);
  });

  it("carries the pod's allow-list, read live, as its reach", async () => {
    h.listAllowedHosts.mockResolvedValue([
      "geo.api.gouv.fr",
      "recherche-entreprises.api.gouv.fr",
    ]);
    const payload = await listCaps({ query: "json" });
    const row = payload.skills.find((s) => s.name === "http.get_json");
    expect(row?.reach).toEqual({
      hosts: ["geo.api.gouv.fr", "recherche-entreprises.api.gouv.fr"],
      connections: [],
      unreadSteps: 0,
    });
    // Another verb is not measured here: no reach, never "nothing".
    const other = payload.skills.find((s) => s.name === "http.allow_host");
    expect(other).toBeDefined();
    expect(other).not.toHaveProperty("reach");
  });

  it("an empty list is measured: it reaches nothing until a host is allowed", async () => {
    h.listAllowedHosts.mockResolvedValue([]);
    const payload = await listCaps({ query: "json" });
    expect(
      payload.skills.find((s) => s.name === "http.get_json")?.reach
    ).toEqual({ hosts: [], connections: [], unreadSteps: 0 });
  });

  it("the list is not read when the page shows no http.get_json row", async () => {
    h.listCapabilities.mockResolvedValue([coreRow("http.allow_host")]);
    await listCaps({ query: "allow" });
    expect(h.listAllowedHosts).not.toHaveBeenCalled();
  });
});
