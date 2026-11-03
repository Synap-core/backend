import { describe, expect, it } from "vitest";
import { computerRuleGroups, type RuleRowLike } from "./computer-writes";

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
