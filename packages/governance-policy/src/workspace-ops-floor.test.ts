/**
 * WORKSPACE OPERATIONS FLOOR (R8a) — an agent archiving or restoring a
 * workspace, or granting a workspace access to a shared profile, ALWAYS
 * proposes.
 *
 *   - `workspaces.archive` is the bare `archive` verb: rung 2.5
 *     (DESTRUCTIVE_ACTIONS). The router passes the PLURAL subject.
 *   - `workspaces.restore` / `profile.grant_access` sit in ADMIN_ACTIONS_LIVE
 *     (rung 2): lifecycle / scope changes no rule may widen.
 *
 * Each widener below EXECUTES an ordinary write (the control column proves it),
 * so each row rules out "the floor is missing" rather than "nothing widened".
 */
import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS_LIVE,
  GATE_WRITE_DOORS,
  decideAgentPolicy,
} from "./index.js";

const WIDENERS: Array<[string, Parameters<typeof decideAgentPolicy>[0]]> = [
  [
    "a rung-2.8 rule says auto",
    { subjectType: "", action: "", governanceRuleVerdict: "auto" },
  ],
  [
    "autoApproveFor names it (rung 4)",
    {
      subjectType: "",
      action: "",
      autoApproveFor: [
        "*",
        "*.*",
        "workspace.*",
        "workspaces.*",
        "profile.*",
        "entity.*",
      ],
    },
  ],
  [
    "agent-owned workspace (rung 3)",
    { subjectType: "", action: "", isAgentOwnedWorkspace: true },
  ],
];

const CASES: Array<[string, string, string]> = [
  // [subjectType, action, expected reasonCode]
  ["workspaces", "archive", "DESTRUCTIVE_HARD_FLOOR"],
  ["workspace", "archive", "DESTRUCTIVE_HARD_FLOOR"],
  ["workspaces", "restore", "ADMIN"],
  ["workspace", "restore", "ADMIN"],
  ["profile", "grant_access", "ADMIN"],
];

describe("workspace operations — floored for agents", () => {
  it("the three doors are real gate doors", () => {
    const doors = Object.keys(GATE_WRITE_DOORS);
    expect(doors).toContain("workspace/archive");
    expect(doors).toContain("workspace/restore");
    expect(doors).toContain("profile/grant_access");
    const admin = ADMIN_ACTIONS_LIVE as readonly string[];
    expect(admin).toContain("workspaces.restore");
    expect(admin).toContain("profile.grant_access");
  });

  for (const [subjectType, action, reasonCode] of CASES) {
    it.each(WIDENERS)(
      `${subjectType}.${action} proposes when %s`,
      (_label, base) => {
        const verdict = decideAgentPolicy({ ...base, subjectType, action });
        expect(verdict).toMatchObject({ verdict: "propose", reasonCode });
        // CONTROL — the same widener executes an ordinary write.
        const control = decideAgentPolicy({
          ...base,
          subjectType: "entity",
          action: "update",
        });
        expect(control.verdict).toBe("execute");
      }
    );
  }

  it("a destructive archive never auto-approves, even with every widener at once", () => {
    const verdict = decideAgentPolicy({
      subjectType: "workspaces",
      action: "archive",
      governanceRuleVerdict: "auto",
      autoApproveFor: ["*", "*.*", "workspaces.archive"],
      isAgentOwnedWorkspace: true,
    });
    expect(verdict).toMatchObject({
      verdict: "propose",
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });
});
