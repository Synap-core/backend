/**
 * synap_list_capabilities pages. Measured on the founder's pod 2026-11-09: a
 * default browse was 45,095 chars (over the 16,000 reply cap, cut mid-JSON).
 * A browse is now one page of 20 distinct rows with total/offset/nextOffset;
 * the registry is stubbed, `sectionCapabilities` is real.
 */
import { describe, it, expect, vi } from "vitest";
import type { RegistryCapability } from "../../services/capabilities/capability-registry.js";

const { listCapabilities } = vi.hoisted(() => ({ listCapabilities: vi.fn() }));
vi.mock(
  "../../services/capabilities/capability-registry.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/capabilities/capability-registry.js")
    >()),
    listCapabilities,
  })
);
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));
vi.mock("../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hub-protocol/rest/_shared.js")>()),
  getUserMemberWorkspaceIds: vi.fn(async () => ["ws-1"]),
}));
vi.mock("../../access/door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../access/door.js")>()),
  canRead: vi.fn(async () => true),
}));

import { executeMCPToolViaHubProtocol } from "./adapter.js";

const ROWS = Array.from(
  { length: 45 },
  (_, i) =>
    ({
      id: `t${i}`,
      kind: "tool",
      name: `tool_${String(i).padStart(2, "0")}`,
      description: null,
      inputSchema: {},
      executor: "is-agent",
      governance: "propose",
      enabled: true,
      verbs: [],
    }) as unknown as RegistryCapability
);

async function call(args: Record<string, unknown>) {
  listCapabilities.mockResolvedValue(ROWS);
  const res = await executeMCPToolViaHubProtocol(
    "synap_list_capabilities",
    { workspaceId: "ws-1", ...args },
    "user-1",
    ["mcp.read"]
  );
  const block = res.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as Record<string, any>;
}

describe("synap_list_capabilities pages", () => {
  it("a browse is one page of 20 distinct rows with total and nextOffset", async () => {
    const body = await call({});
    expect(body.integrations).toHaveLength(20);
    expect(body).toMatchObject({ total: 45, offset: 0, nextOffset: 20 });
  });

  it("walking nextOffset yields every capability once; the last page has no nextOffset", async () => {
    const names: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const body = await call({ offset });
      names.push(...body.integrations.map((i: { name: string }) => i.name));
      offset = body.nextOffset;
    }
    expect(names.sort()).toEqual(ROWS.map((r) => r.name).sort());
  });

  it("an explicit limit sizes the page", async () => {
    const body = await call({ limit: 5, offset: 40 });
    expect(body.integrations).toHaveLength(5);
    expect(body).not.toHaveProperty("nextOffset");
  });
});
