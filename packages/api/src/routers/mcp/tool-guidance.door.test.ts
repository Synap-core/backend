import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A client that drops the MCP `instructions` (Hermes Agent 0.23, finding
 * d812debd) still learns the pod's tools: from `synap_orient`'s RESULT and
 * from `synap_load_skill`'s description, and a guessed parameter name for
 * `load_skill` (`skill`, `name`) still loads. Real `tools.execute` and
 * `tools.list()`; only the key's stored access, the skill door, the skill body
 * and the orient read (the adapter) are mocked at their one seam each.
 */

const access = vi.hoisted(() => ({
  loadKeyToolAccess: vi.fn(),
  unlockKeyToolGroups: vi.fn(),
}));
vi.mock("./tool-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tool-access.js")>()),
  ...access,
}));
const skills = vi.hoisted(() => ({
  resolveSkillContent: vi.fn(async (ref: string) => `# body of ${ref}`),
}));
vi.mock("../../services/capability-briefs/load-skill.js", () => skills);
const door = vi.hoisted(() => ({ resolveSkillDoor: vi.fn() }));
vi.mock("../../services/capability-briefs/resolve-skill-door.js", () => door);
const adapter = vi.hoisted(() => ({ executeMCPToolViaHubProtocol: vi.fn() }));
vi.mock("./adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapter.js")>()),
  ...adapter,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: {} };
});

import { tools } from "./tools/index.js";
import { ENTRY_REFLEX_PROSE } from "./entry-instructions.js";
import {
  BUILDER_REF,
  ENTRY_TOOLS,
  TOOL_GROUP_NAMES,
  TOOL_GROUP_PURPOSES,
  toolGroupRef,
} from "./tool-profiles.js";
import { loadSkillCall } from "./tool-guidance.js";
import { DOOR_TOOL_NAMES } from "./door-tool-names.generated.js";

type Result = { isError?: boolean; content: Array<{ text?: string }> };
const text = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");

const ORIENT_BODY = {
  startHere: { pendingReview: [] },
  identity: { name: "hermes" },
};

async function orient(keyId?: string): Promise<Record<string, unknown>> {
  const res = (await tools.execute(
    "synap_orient",
    {},
    "u1",
    ["mcp.read"],
    "u1",
    "agent-1",
    undefined,
    undefined,
    keyId ? { keyId } : undefined
  )) as Result;
  expect(res.isError).not.toBe(true);
  return JSON.parse(res.content[0]!.text!) as Record<string, unknown>;
}

beforeEach(() => {
  access.loadKeyToolAccess.mockReset();
  access.unlockKeyToolGroups.mockReset();
  door.resolveSkillDoor.mockReset().mockResolvedValue("pod-mcp");
  adapter.executeMCPToolViaHubProtocol.mockReset().mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(ORIENT_BODY) }],
  });
});

describe("synap_orient carries `yourTools`", () => {
  it("an ENTRY key: what it lists, what ask is for, the exact unlock call and every locked group", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    const out = await orient("key-1");
    // Right after startHere, before the rest — the first thing read.
    expect(Object.keys(out).slice(0, 3)).toEqual([
      "startHere",
      "yourTools",
      "identity",
    ]);
    const yt = out.yourTools as Record<string, unknown>;
    expect(yt.profile).toBe("entry");
    expect(yt.listed).toContain(`${ENTRY_TOOLS.length} essential tools`);
    expect(yt.ask).toMatch(/^synap_ask asks the pod/);
    expect(yt.unlock).toContain('synap_load_skill({ref: "tools:read"})');
    expect(yt.unlock).toContain(BUILDER_REF);
    // An unlocked tool runs at once through the dispatcher: no reconnect.
    expect(yt.unlock).toContain("synap_call_tool({tool, arguments})");
    expect(yt.unlock).not.toMatch(/reconnect|next conversation/i);
    expect(yt.groups).toEqual(
      Object.fromEntries(
        TOOL_GROUP_NAMES.map((g) => [toolGroupRef(g), TOOL_GROUP_PURPOSES[g]])
      )
    );
    expect(access.loadKeyToolAccess).toHaveBeenCalledWith("key-1");
  });

  it("names the groups already unlocked and offers only the others", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: ["read", "tracks"],
    });
    const yt = (await orient("key-1")).yourTools as Record<string, unknown>;
    expect(yt.unlocked).toEqual(["tools:read", "tools:tracks"]);
    expect(Object.keys(yt.groups as object)).not.toContain("tools:read");
    // The example call names a group still locked.
    expect(yt.unlock).toContain('synap_load_skill({ref: "tools:data"})');
  });

  it("the claude.ai connector's key reads its own tool names (pod__*)", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    door.resolveSkillDoor.mockResolvedValue("cp-connector");
    const yt = (await orient("key-cp")).yourTools as Record<string, unknown>;
    expect(yt.ask).toMatch(/^pod__ask /);
    expect(yt.unlock).toContain('pod__load_skill({ref: "tools:read"})');
    // The connector's own name for the dispatcher, once its curated catalog
    // carries it (the generated door table); the pod name until then.
    expect(yt.unlock).toContain(
      `${DOOR_TOOL_NAMES.synap_call_tool?.["cp-connector"] ?? "synap_call_tool"}({tool, arguments})`
    );
    expect(yt.unlock).not.toMatch(/reconnect|next conversation/i);
  });

  it("a key that lists every tool (legacy NULL, builder) or no key at all says so", async () => {
    access.loadKeyToolAccess.mockResolvedValue({ profile: null, groups: [] });
    const legacy = (await orient("key-legacy")).yourTools as Record<
      string,
      unknown
    >;
    expect(legacy.listed).toBe("This key lists every Synap tool.");
    expect(legacy).not.toHaveProperty("unlock");
    const none = (await orient(undefined)).yourTools as Record<string, unknown>;
    expect(none.profile).toBe("all");
    expect(access.loadKeyToolAccess).toHaveBeenCalledTimes(1);
  });

  it("a failed profile read is said, not guessed — and orient still answers", async () => {
    access.loadKeyToolAccess.mockRejectedValue(new Error("db down"));
    const out = await orient("key-1");
    const yt = out.yourTools as Record<string, unknown>;
    expect(yt.unavailable).toContain("db down");
    expect(yt).not.toHaveProperty("profile");
    expect(out.identity).toEqual(ORIENT_BODY.identity);
  });

  it("an orient error passes through untouched", async () => {
    const err = { isError: true, content: [{ type: "text", text: "boom" }] };
    adapter.executeMCPToolViaHubProtocol.mockResolvedValue(err);
    const res = await tools.execute(
      "synap_orient",
      {},
      "u1",
      ["mcp.read"],
      "u1"
    );
    expect(res).toEqual(err);
  });
});

describe("synap_load_skill teaches its own use and forgives the parameter name", () => {
  it("its description shows the exact call and every group with what it is for", async () => {
    const def = (await tools.list()).find(
      (t) => t.name === "synap_load_skill"
    )!;
    expect(def.description).toContain(loadSkillCall("synap_load_skill"));
    for (const g of TOOL_GROUP_NAMES) {
      expect(def.description).toContain(
        `'${toolGroupRef(g)}' (${TOOL_GROUP_PURPOSES[g]})`
      );
    }
  });

  it("declares `skill` and `name` beside `ref`, and requires none of them in the schema", async () => {
    const def = (await tools.list()).find(
      (t) => t.name === "synap_load_skill"
    )!;
    const props = def.inputSchema.properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["ref", "skill", "name"])
    );
    expect(def.inputSchema.required ?? []).not.toContain("ref");
  });

  for (const key of ["skill", "name"] as const) {
    it(`{${key}: <ref>} loads like {ref: <ref>}`, async () => {
      const res = (await tools.execute(
        "synap_load_skill",
        { [key]: "focus-sessions" },
        "u1",
        ["mcp.read"],
        "u1"
      )) as Result;
      expect(res.isError).not.toBe(true);
      expect(text(res)).toContain("# body of focus-sessions");
    });
  }

  it("`ref` wins over an alias", async () => {
    const res = (await tools.execute(
      "synap_load_skill",
      { ref: "writes", skill: "focus-sessions" },
      "u1",
      ["mcp.read"],
      "u1"
    )) as Result;
    expect(text(res)).toContain("# body of writes");
  });

  it("an alias unlocks a tool group too", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    access.unlockKeyToolGroups.mockResolvedValue(["read"]);
    const res = (await tools.execute(
      "synap_load_skill",
      { skill: "tools:read" },
      "u1",
      ["mcp.read"],
      "u1",
      undefined,
      undefined,
      undefined,
      { keyId: "key-1" }
    )) as Result;
    expect(access.unlockKeyToolGroups).toHaveBeenCalledWith("key-1", ["read"]);
    expect(text(res)).toContain("Unlocked tool group: read");
  });

  it("nothing passed: the refusal shows the exact call", async () => {
    const res = (await tools.execute(
      "synap_load_skill",
      {},
      "u1",
      ["mcp.read"],
      "u1"
    )) as Result;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(loadSkillCall("synap_load_skill"));
  });
});

describe("one source: the instructions say what the tools say", () => {
  it("the entry instructions carry the same call and every group ref", () => {
    expect(ENTRY_REFLEX_PROSE).toContain(loadSkillCall("load_skill"));
    for (const g of TOOL_GROUP_NAMES) {
      expect(ENTRY_REFLEX_PROSE).toContain(`\`${toolGroupRef(g)}\``);
    }
  });
});
