/**
 * `synap_load_skill` renders tool names for the door serving it — driven through
 * the REAL `tools.execute` dispatch, the REAL door resolver (its one `users`
 * read stubbed at the database boundary) and the REAL renderer. Only the skill
 * body read and the focus read are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  agentType: null as string | null,
  userReads: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table !== actual.users)
                throw new Error("unexpected table read");
              h.userReads++;
              return h.agentType === null ? [] : [{ agentType: h.agentType }];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock("../../../services/capability-briefs/load-skill.js", () => ({
  resolveSkillContent: async () =>
    "Call `synap_define_kind` after `list_profiles`; crystallize with `promote_session_to_playbook`.",
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAgentFocusWorkspaceId: async () => null,
  })
);

import { tools } from "./index.js";

const load = async (agentUserId?: string) => {
  const res = await tools.execute(
    "synap_load_skill",
    { ref: "escalation-ladder" },
    "u1",
    ["mcp.read"],
    "u1",
    agentUserId
  );
  return (res.content[0] as { text: string }).text;
};

beforeEach(() => {
  h.agentType = null;
  h.userReads = 0;
});

describe("synap_load_skill door rendering", () => {
  it("claude.ai connector key (agentType claude-web) reads pod__ names and a door note", async () => {
    h.agentType = "claude-web";
    const text = await load("agent-cp");
    expect(text).toContain("`pod__define_kind` after `pod__list_profiles`");
    expect(text).toContain("`synap_promote_session_to_playbook†`");
    expect(text).toContain("Door note (claude.ai Synap connector)");
    expect(h.userReads).toBe(1);
  });

  it("any other agent on /mcp reads pod names, bare stems prefixed", async () => {
    h.agentType = "claude-code";
    const text = await load("agent-cc");
    expect(text).toContain("`synap_define_kind` after `synap_list_profiles`");
    expect(text).not.toContain("Door note");
  });

  it("no agent identity: pod names, no identity read", async () => {
    const text = await load();
    expect(text).toContain("`synap_list_profiles`");
    expect(h.userReads).toBe(0);
  });
});
