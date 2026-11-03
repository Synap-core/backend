import { describe, expect, it } from "vitest";
import {
  agentModeOnComputer,
  agentsChangedBy,
  computerRuleGroups,
  heldByThisComputer,
  type AgentOnComputerRead,
  type RuleRowLike,
} from "./computer-writes";

const PC = "pc-1";
const CC = "agent-cc";
const CODEX = "agent-codex";
const AGENTS = [
  { id: CC, name: "Claude Code", agentType: "claude-code" },
  { id: CODEX, name: "Codex", agentType: "codex" },
];

let n = 0;
const rule = (over: Partial<RuleRowLike>): RuleRowLike => ({
  id: `r${++n}`,
  principalKind: "agent",
  agentUserId: null,
  principalClass: null,
  scopeKind: "pod",
  workspaceId: null,
  targetKind: "action",
  targetPattern: "entity.create",
  targetProfile: null,
  verdict: "propose",
  ...over,
});

describe("the rules a computer's page lists, by source", () => {
  it("tags each rule with where it comes from, in reading order, and leaves out anyone else's", () => {
    const rows = [
      rule({
        principalKind: "any",
        targetPattern: "@reversible",
        verdict: "auto",
      }),
      rule({
        agentUserId: CC,
        verdict: "auto",
        scopeKind: "workspace",
        workspaceId: "ws-1",
      }),
      rule({ agentUserId: PC }),
      rule({ agentUserId: "someone-else" }),
      rule({
        principalKind: "class",
        principalClass: "machine",
        targetPattern: "document.update",
      }),
      rule({ principalKind: "class", principalClass: "claude-code" }),
      rule({ principalKind: "class", principalClass: "cursor" }),
      rule({ agentUserId: PC, targetPattern: "entity.update" }),
    ];
    const groups = computerRuleGroups(rows, { computerId: PC, agents: AGENTS });
    expect(groups.map((g) => g.source)).toEqual([
      { kind: "computer" },
      { kind: "allComputers" },
      { kind: "agent", agentId: CC, name: "Claude Code" },
      { kind: "agentClass", agentType: "claude-code" },
      { kind: "pod" },
    ]);
    expect(groups[0]!.rules).toHaveLength(2);
    // A space-limited rule keeps its space; a pod-wide one has none.
    expect(groups[2]!.rules[0]).toMatchObject({
      verdict: "auto",
      workspaceId: "ws-1",
    });
    expect(groups[0]!.rules[0]!.workspaceId).toBeNull();
    // Nobody else's rule, and no other agent type's class rule.
    const ids = groups.flatMap((g) => g.rules.map((r) => r.id));
    expect(ids).toHaveLength(6);
  });

  it("names a class of writes for the page's own words, and a single write by the vocabulary", () => {
    const [pod] = computerRuleGroups(
      [
        rule({
          principalKind: "any",
          targetPattern: "@reversible",
          verdict: "auto",
        }),
      ],
      { computerId: PC, agents: AGENTS }
    );
    expect(pod!.rules[0]!.targetClass).toBe("reversible");
    const [own] = computerRuleGroups(
      [rule({ agentUserId: PC, targetPattern: "entity.create" })],
      { computerId: PC, agents: AGENTS }
    );
    expect(own!.rules[0]!.targetClass).toBeNull();
    expect(own!.rules[0]!.what).not.toMatch(/entity\.create/);
  });

  it("no rule about the computer or its agents: nothing to list", () => {
    expect(
      computerRuleGroups([rule({ agentUserId: "someone-else" })], {
        computerId: PC,
        agents: AGENTS,
      })
    ).toEqual([]);
  });
});

describe("its agents on the computer page", () => {
  const read = (
    own: string | null,
    effective?: AgentOnComputerRead["effective"]
  ): AgentOnComputerRead => ({
    writeMode: (own ?? "pod-default") as AgentOnComputerRead["writeMode"],
    postures: { pod: own },
    effective,
  });
  const eff = (
    writeMode: "pod-default" | "create-with-undo" | "ask-first",
    decidedBy: "agent" | "computer" | "pod-default"
  ) => ({
    writeMode,
    line: "",
    decidedBy,
    computer: { id: "pc-1", name: "Mac" },
  });

  it("each row shows the mode its writes really follow, and whether this computer set it", () => {
    // The founder's case: Claude Code on Normal, its Mac ask-first.
    expect(
      agentModeOnComputer(read(null, eff("ask-first", "computer")))
    ).toEqual({ mode: "ask-first", source: "computer" });
    expect(
      agentModeOnComputer(read("ask-first", eff("ask-first", "agent")))
    ).toEqual({ mode: "ask-first", source: "agent" });
    // A pod with no effective read: the agent's own setting.
    expect(agentModeOnComputer(read("create-with-undo"))).toEqual({
      mode: "create-with-undo",
      source: "agent",
    });
    expect(agentModeOnComputer(read(null))).toEqual({
      mode: "pod-default",
      source: "pod-default",
    });
  });

  it("counts the agents this computer holds back", () => {
    expect(
      heldByThisComputer([
        read(null, eff("ask-first", "computer")),
        read("create-with-undo", eff("ask-first", "computer")),
        read("ask-first", eff("ask-first", "agent")),
      ])
    ).toBe(2);
  });

  it("before saving, says how many agents a new computer mode changes: the stricter of the two moves", () => {
    const agents = [read(null), read("create-with-undo"), read("ask-first")];
    // Ask first → Normal frees the first two; the third asks first itself.
    expect(agentsChangedBy(agents, "ask-first", "pod-default")).toBe(2);
    // Normal → Creates only: only the agent on Normal is held back.
    expect(agentsChangedBy(agents, "pod-default", "create-with-undo")).toBe(1);
    expect(agentsChangedBy(agents, "ask-first", "ask-first")).toBe(0);
    expect(agentsChangedBy([], "ask-first", "pod-default")).toBe(0);
  });
});
