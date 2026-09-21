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
  skillText: "",
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
  resolveSkillContent: async () => h.skillText,
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAgentFocusWorkspaceId: async () => null,
  })
);

import { tools } from "./index.js";
import { DOOR_TOOL_NAMES } from "../door-tool-names.generated.js";
import { renderSkillForDoor } from "../../../services/capability-briefs/door-tool-render.js";

/** A pod tool this door does NOT carry — DERIVED, never a hand-picked name. */
function absentFrom(door: "cp-connector" | "raycast"): string | undefined {
  return Object.keys(DOOR_TOOL_NAMES)
    .sort()
    .find((tool) => DOOR_TOOL_NAMES[tool]![door] === null);
}

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
  h.skillText =
    "Call `synap_define_kind` after `list_profiles`; crystallize with `promote_session_to_playbook`.";
});

describe("synap_load_skill door rendering", () => {
  it("claude.ai connector key (agentType claude-web) reads pod__ names and a door note", async () => {
    h.agentType = "claude-web";
    // The tool this case used to dagger (`promote_session_to_playbook`) has
    // since been curated onto the CP door, so the hand-picked name rotted into
    // a false failure. Derive instead: dagger whatever that door still lacks.
    const absent = absentFrom("cp-connector");
    if (absent) h.skillText += ` Then \`${absent.replace(/^synap_/, "")}\`.`;
    const text = await load("agent-cp");
    expect(text).toContain("`pod__define_kind` after `pod__list_profiles`");
    expect(text).toContain("`pod__promote_session_to_playbook`");
    expect(h.userReads).toBe(1);
    if (absent) {
      expect(text).toContain(`\`${absent}†\``);
      expect(text).toContain("Door note (claude.ai Synap connector)");
    } else {
      // Full coverage today: every pod tool is curated on the CP connector, so
      // this door has nothing to mark. The dagger itself stays covered by the
      // raycast case below — do not delete it because this branch is quiet.
      expect(text).not.toContain("Door note");
    }
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

  it("a door that LACKS a tool daggers it and explains — derived, on the raycast door", () => {
    const absent = absentFrom("raycast");
    expect(
      absent,
      "no pod tool is absent from the raycast door — if that is real, the dagger path is dead and this test should say so"
    ).toBeTruthy();
    const stem = absent!.replace(/^synap_/, "");
    const rendered = renderSkillForDoor(
      `Use \`${stem}\` for that step.`,
      "raycast"
    );
    expect(rendered).toContain(`\`${absent}†\``);
    expect(rendered).toContain("Door note");
    // Reachability, not shape: the note must name the tool AND say it is absent.
    expect(rendered).toMatch(new RegExp(`- \\\`${absent}\\\` — not on`));
  });
});
