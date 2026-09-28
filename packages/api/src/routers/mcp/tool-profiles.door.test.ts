import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The DOOR half of MCP tool profiles (V1 D4): what `tools/list` really
 * advertises for a key, and what `synap_load_skill(<group>)` does on it.
 * The key's stored access is mocked at its one reader (`tool-access.ts`);
 * everything between that and the client — the live server's `tools/list`
 * handler, `tools.execute` — is the real code.
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
vi.mock("../../services/capability-briefs/resolve-skill-door.js", () => ({
  resolveSkillDoor: vi.fn(async () => null),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: {} };
});

import { createMCPServer } from "./index.js";
import { tools } from "./tools/index.js";
import { ENTRY_TOOLS, TOOL_GROUPS } from "./tool-profiles.js";

type Handler = (
  req: unknown,
  extra: unknown
) => Promise<{ tools: { name: string }[] }>;

async function listFor(keyId?: string): Promise<string[]> {
  const server = createMCPServer(
    undefined,
    "u1",
    undefined,
    undefined,
    undefined,
    ["mcp.read", "mcp.write"],
    undefined,
    undefined,
    keyId
  ) as unknown as { _requestHandlers: Map<string, Handler> };
  const handler = server._requestHandlers.get("tools/list");
  if (!handler) throw new Error("SDK no longer exposes _requestHandlers");
  const res = await handler({ method: "tools/list", params: {} }, {});
  return res.tools.map((t) => t.name);
}

const text = (r: { content: unknown[] }) =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");

beforeEach(() => {
  access.loadKeyToolAccess.mockReset();
  access.unlockKeyToolGroups.mockReset();
});

describe("tools/list honours the key's profile", () => {
  it("an ENTRY key lists exactly the 9 entry tools", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    expect((await listFor("key-1")).sort()).toEqual([...ENTRY_TOOLS].sort());
    expect(access.loadKeyToolAccess).toHaveBeenCalledWith("key-1");
  });

  it("an entry key with an unlocked group lists that group too", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: ["tracks"],
    });
    const names = await listFor("key-1");
    expect(names).toHaveLength(ENTRY_TOOLS.length + TOOL_GROUPS.tracks.length);
    expect(names).toContain("synap_start_track");
  });

  it("a LEGACY key (NULL profile — every key before 0280) lists every tool, unchanged", async () => {
    access.loadKeyToolAccess.mockResolvedValue({ profile: null, groups: [] });
    const all = (await tools.list({ door: "chat" })).length;
    expect(await listFor("key-legacy")).toHaveLength(all);
    expect(all).toBeGreaterThan(60);
  });

  it("a failed access read fails the list — never a silent 'every tool' or 'no tools'", async () => {
    access.loadKeyToolAccess.mockRejectedValue(new Error("db down"));
    await expect(listFor("key-1")).rejects.toThrow("db down");
  });

  it("no key (stdio / dev) reads nothing and lists every tool", async () => {
    await listFor(undefined);
    expect(access.loadKeyToolAccess).not.toHaveBeenCalled();
  });
});

describe("synap_load_skill(<group>) unlocks on an entry key", () => {
  const exec = (
    ref: string,
    toolAccess?: { keyId: string; notifyToolsChanged?: () => Promise<void> }
  ) =>
    tools.execute(
      "synap_load_skill",
      { ref },
      "u1",
      ["mcp.read", "mcp.write"],
      "u1",
      undefined,
      undefined,
      undefined,
      toolAccess
    ) as Promise<{ content: unknown[] }>;

  it("persists the group, pings list_changed, and inlines the new tools' schemas", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    access.unlockKeyToolGroups.mockResolvedValue(["schema"]);
    const notify = vi.fn().mockResolvedValue(undefined);
    const out = text(
      await exec("tools:schema", { keyId: "key-1", notifyToolsChanged: notify })
    );
    expect(access.unlockKeyToolGroups).toHaveBeenCalledWith("key-1", [
      "schema",
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(out).toContain("Unlocked tool group: schema");
    // Honest about delivery: the HTTP door drops list_changed.
    expect(out).toContain("after you reconnect");
    expect(out).toContain('"name":"synap_define_kind"');
    expect(out).toContain('"inputSchema"');
  });

  it("builder unlocks every group but names the tools instead of inlining ~70 schemas", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    access.unlockKeyToolGroups.mockImplementation(
      async (_k: string, g: string[]) => g
    );
    const out = text(await exec("tools:builder", { keyId: "key-1" }));
    expect(out).toContain("synap_create_view");
    expect(out).not.toContain('"inputSchema"');
  });

  it("an already-unlocked group changes nothing and does not ping", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: ["schema"],
    });
    access.unlockKeyToolGroups.mockResolvedValue([]);
    const notify = vi.fn();
    expect(
      text(
        await exec("tools:schema", {
          keyId: "key-1",
          notifyToolsChanged: notify,
        })
      )
    ).toContain("Already unlocked: schema");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a legacy / builder key already lists everything — nothing is written", async () => {
    access.loadKeyToolAccess.mockResolvedValue({ profile: null, groups: [] });
    expect(text(await exec("tools:schema", { keyId: "key-legacy" }))).toContain(
      "already lists every Synap tool"
    );
    expect(access.unlockKeyToolGroups).not.toHaveBeenCalled();
  });

  it("a bare ref that is ALSO a group name loads the SKILL (skills resolve first)", async () => {
    access.loadKeyToolAccess.mockResolvedValue({
      profile: "entry",
      groups: [],
    });
    access.unlockKeyToolGroups.mockResolvedValue(["governance"]);
    const out = text(await exec("governance", { keyId: "key-1" }));
    expect(skills.resolveSkillContent).toHaveBeenCalledWith(
      "governance",
      "u1",
      undefined
    );
    expect(out).toContain("# body of governance");
    // …and the skill's teaching still unlocks the group it uses.
    expect(out).toContain("Unlocked tool group: governance");
  });

  it("a missing or empty ref is a clear error, never a crash", async () => {
    for (const args of [{}, { ref: "" }, { ref: 42 }]) {
      const res = (await tools.execute(
        "synap_load_skill",
        args,
        "u1",
        ["mcp.read"],
        "u1"
      )) as { isError?: boolean; content: unknown[] };
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("`ref` is required");
    }
  });

  it("an unknown tools: group names the real ones and unlocks nothing", async () => {
    const res = (await exec("tools:everything", { keyId: "key-1" })) as {
      isError?: boolean;
      content: unknown[];
    };
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("tools:tracks");
    expect(access.unlockKeyToolGroups).not.toHaveBeenCalled();
  });
});
