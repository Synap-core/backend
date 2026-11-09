/**
 * The self-healing match (`matchAgentTemplate`, founder decision D10), pure,
 * on the founder's own 27 connected agents (`synap_list_agents`, 5 Nov 2026)
 * against the 17 official agent templates of the catalog.
 *
 * Pinned: every agent whose type already names a program links by type; the
 * two the plan named as clear (`claude-code-devbox`, `hermes`) link; the ten
 * whose program no type or name says are asked, never guessed; two programs
 * at one rule are not clear.
 */

import { describe, expect, it } from "vitest";
import {
  agentTemplateAskSlot,
  AGENT_TEMPLATE_NONE_OPTION,
  matchAgentTemplate,
} from "./self-heal.js";

const OFFICIAL = [
  ["claude-code", "claude-code", "Claude Code"],
  ["claude-desktop", "claude-desktop", "Claude Desktop"],
  ["cursor", "cursor", "Cursor"],
  ["raycast", "raycast", "Raycast"],
  ["codex", "codex", "Codex"],
  ["openwebui", "openwebui", "Open WebUI"],
  ["discord", "discord", "Discord"],
  ["proton-agent", "proton", "Proton"],
  ["generic", "generic", "Generic"],
  ["chatgpt", "chatgpt", "ChatGPT"],
  ["opencode", "opencode", "OpenCode"],
  ["windsurf", "windsurf", "Windsurf"],
  ["goose", "goose", "Goose"],
  ["zed", "zed", "Zed"],
  ["vscode", "vscode", "VS Code"],
  ["grok", "grok", "Grok"],
  ["hermes", "hermes", "Hermes Agent"],
].map(([slug, harness, name]) => ({
  slug: slug!,
  harness: harness!,
  name: name!,
  aliases: [] as string[],
}));

/** The founder's connected agents (reach pull), name × type. */
const FOUNDER: Array<[string, string]> = [
  ["Claude Code", "claude-code"],
  ["Claude Code", "claude-code"],
  ["Claude-code-devbox", "claude-code-devbox"],
  ["Claude (Web)", "claude-web"],
  ["Raycast", "raycast"],
  ["Feynman", "feynman"],
  ["Codex", "codex"],
  ["Codex", "codex"],
  ["Design-canvas", "design-canvas"],
  ["Grok", "grok"],
  ["Deepseek", "deepseek"],
  ["Cursor", "cursor"],
  ["Generic", "generic"],
  ["Eve", "eve"],
  ["Dogfood-check", "dogfood-check"],
  ["Coder", "coder"],
  ["Openwebui", "openwebui"],
  ["Hermes", "hermes"],
  ["Openclaw", "openclaw"],
  ["Eve", "eve"],
  ["Discord", "discord"],
  ["Codex", "codex"],
  ["Cursor", "cursor"],
  ["CRM worker", "claude-code"],
  ["Mac-worker", "mac-worker"],
  ["Claude-code", "claude-code"],
  ["Claude-desktop", "claude-desktop"],
];

describe("matchAgentTemplate — the founder's 27 connected agents", () => {
  const results = FOUNDER.map(([name, agentType]) => ({
    agentType,
    match: matchAgentTemplate({ name, agentType }, OFFICIAL),
  }));

  it("links 17: 15 by their type, claude-code-devbox by its type's prefix, hermes now that Hermes is installed", () => {
    const linked = results.filter((r) => r.match);
    expect(linked).toHaveLength(17);
    expect(
      results.find((r) => r.agentType === "claude-code-devbox")!.match
    ).toEqual({
      slug: "claude-code",
      rule: "type_prefix",
    });
    expect(results.find((r) => r.agentType === "hermes")!.match).toEqual({
      slug: "hermes",
      rule: "type",
    });
    expect(results.find((r) => r.agentType === "grok")!.match?.slug).toBe(
      "grok"
    );
  });

  it("asks about the 10 whose program no type or name says — never a guess", () => {
    expect(
      results
        .filter((r) => !r.match)
        .map((r) => r.agentType)
        .sort()
    ).toEqual([
      "claude-web",
      "coder",
      "deepseek",
      "design-canvas",
      "dogfood-check",
      "eve",
      "eve",
      "feynman",
      "mac-worker",
      "openclaw",
    ]);
  });
});

describe("matchAgentTemplate — the rules", () => {
  it("an alias links; a name links when the type says nothing", () => {
    const withAlias = [{ ...OFFICIAL[0]!, aliases: ["claude"] }];
    expect(
      matchAgentTemplate({ name: "x", agentType: "claude" }, withAlias)
    ).toEqual({
      slug: "claude-code",
      rule: "alias",
    });
    expect(
      matchAgentTemplate(
        { name: "Hermes Agent", agentType: "eve-runtime" },
        OFFICIAL
      )
    ).toEqual({
      slug: "hermes",
      rule: "name",
    });
    expect(
      matchAgentTemplate(
        { name: "Claude Code on devbox", agentType: "worker-7" },
        OFFICIAL
      )
    ).toEqual({
      slug: "claude-code",
      rule: "name_prefix",
    });
  });

  it("two programs at one rule are not clear; the longest type prefix is", () => {
    const twins = [
      { slug: "a", harness: "a", name: "Same", aliases: [] },
      { slug: "b", harness: "b", name: "Same", aliases: [] },
    ];
    expect(
      matchAgentTemplate({ name: "Same", agentType: "zzz" }, twins)
    ).toBeNull();
    const nested = [
      { slug: "claude", harness: "claude", name: "Claude", aliases: [] },
      {
        slug: "claude-code",
        harness: "claude-code",
        name: "Claude Code",
        aliases: [],
      },
    ];
    expect(
      matchAgentTemplate(
        { name: null, agentType: "claude-code-devbox" },
        nested
      )?.slug
    ).toBe("claude-code");
  });

  it("no type and no name match nothing", () => {
    expect(
      matchAgentTemplate({ name: null, agentType: null }, OFFICIAL)
    ).toBeNull();
    expect(
      matchAgentTemplate({ name: "", agentType: "" }, OFFICIAL)
    ).toBeNull();
  });
});

describe("agentTemplateAskSlot — ONE card, one choice per agent", () => {
  it("owed by the person, a form whose choices are the programs plus None of these", () => {
    const slot = agentTemplateAskSlot(
      [
        { id: "a1", name: "Eve", agentType: "eve" },
        { id: "a2", name: "Coder", agentType: "coder" },
      ],
      OFFICIAL,
      new Date("2026-11-05T00:00:00Z")
    );
    expect(slot).toMatchObject({
      kind: "agent_template_link",
      owner: "human",
      blockedReason: "decision",
    });
    const form = slot.ask as {
      mode: string;
      form: { fields: Array<{ key: string; constraints: { enum: string[] } }> };
    };
    expect(form.mode).toBe("form");
    expect(form.form.fields.map((f) => f.key)).toEqual(["a1", "a2"]);
    expect(form.form.fields[0]!.constraints.enum).toContain("Hermes Agent");
    expect(form.form.fields[0]!.constraints.enum.at(-1)).toBe(
      AGENT_TEMPLATE_NONE_OPTION
    );
  });
});
