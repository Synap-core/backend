/**
 * X2 — Synap Core's first-party verbs are ONE summary line by default, and a
 * `containerId` filter lists exactly them.
 *
 * Live (2026-09-14): the default `synap_list_capabilities` answer carried 33
 * Synap Core skills as individual `skills` rows, burying the connectors.
 *
 * Same stubbing pattern as `synap-list-capabilities-explicit-kind.test.ts` — the
 * DB is neutralized, `listCapabilities` is a fixture, and the real handler +
 * real `sectionCapabilities` do the folding under test.
 */
import { describe, it, expect, vi } from "vitest";
import type { RegistryCapability } from "../../services/capabilities/capability-registry.js";

const { listCapabilities } = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
}));

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
  verifyWorkspaceAccess: vi.fn(async () => true),
}));

import { executeMCPToolViaHubProtocol } from "./adapter.js";

const WS = "0aaaaaaa-0000-4000-8000-000000000001";
const CORE = "core-container";
const CORE_VERBS = ["channel.create", "feed.post", "entity.query"];

function cap(
  partial: Partial<RegistryCapability> & { id: string; name: string }
): RegistryCapability {
  return {
    kind: "skill",
    description: null,
    inputSchema: {},
    executor: "is-agent",
    governance: "auto",
    containerId: null,
    containerName: null,
    ...partial,
  } as RegistryCapability;
}

const CATALOG: RegistryCapability[] = [
  cap({
    kind: "tool",
    id: "exa-1",
    name: "exa_api",
    containerId: "exa-container",
    containerName: "Exa — Neural Web Search",
  }),
  ...CORE_VERBS.map((name) =>
    cap({
      id: `id-${name}`,
      name,
      containerId: CORE,
      containerName: "Synap Core",
    })
  ),
  cap({ id: "loose-1", name: "my_own_skill" }),
];

async function call(args: Record<string, unknown>) {
  listCapabilities.mockResolvedValue(CATALOG);
  const result = await executeMCPToolViaHubProtocol(
    "synap_list_capabilities",
    { workspaceId: WS, ...args },
    "user-1",
    ["mcp.read"]
  );
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as {
    skills: Array<{ name: string }>;
    integrations: Array<{ name: string }>;
    builtInPack?: {
      containerId: string;
      name: string;
      verbCount: number;
      note: string;
    };
  };
}

describe("synap_list_capabilities — Synap Core as one line + containerId filter", () => {
  it("default view: Synap Core verbs fold into ONE builtInPack line", async () => {
    const out = await call({});
    expect(out.skills.map((s) => s.name)).toEqual(["my_own_skill"]);
    expect(out.integrations.map((i) => i.name)).toEqual(["exa_api"]);
    expect(out.builtInPack).toMatchObject({
      containerId: CORE,
      name: "Synap Core",
      verbCount: CORE_VERBS.length,
    });
    expect(out.builtInPack?.note).toContain(`containerId:"${CORE}"`);
  });

  it("containerId filter returns ONLY that pack's verbs, unfolded", async () => {
    const out = await call({ containerId: CORE });
    expect(out.skills.map((s) => s.name).sort()).toEqual(
      [...CORE_VERBS].sort()
    );
    expect(out.integrations).toEqual([]);
    expect(out.builtInPack).toBeUndefined();
  });

  it("an explicit query is not folded — the caller asked for rows", async () => {
    const out = await call({ query: "channel" });
    expect(out.skills.map((s) => s.name)).toContain("channel.create");
    expect(out.builtInPack).toBeUndefined();
  });
});
