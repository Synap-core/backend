import { describe, it, expect } from "vitest";
import {
  AUTOMATION_RUN_STATUS_DECLARATION,
  AUTOMATION_RUN_TRANSITIONS,
  AUTOMATION_STATUS_DECLARATION,
  AUTOMATION_TRANSITIONS,
  CHAT_TURN_STATUS_DECLARATION,
  CHAT_TURN_TRANSITIONS,
  INSTALLATION_STATUS_DECLARATION,
  INSTALLATION_TRANSITIONS,
  OPEN_STAGE_RUN_STATUSES,
  PLAYBOOK_STATUS_DECLARATION,
  PLAYBOOK_TRANSITIONS,
  STAGE_RUN_STATUS_DECLARATION,
  STAGE_RUN_TRANSITIONS,
  automationStatusAtCreate,
  canTransition,
  statusesThatMayBecome,
} from "./machines.js";

const MACHINES = {
  automation: [AUTOMATION_STATUS_DECLARATION, AUTOMATION_TRANSITIONS],
  automationRun: [
    AUTOMATION_RUN_STATUS_DECLARATION,
    AUTOMATION_RUN_TRANSITIONS,
  ],
  stageRun: [STAGE_RUN_STATUS_DECLARATION, STAGE_RUN_TRANSITIONS],
  chatTurn: [CHAT_TURN_STATUS_DECLARATION, CHAT_TURN_TRANSITIONS],
  playbook: [PLAYBOOK_STATUS_DECLARATION, PLAYBOOK_TRANSITIONS],
  installation: [INSTALLATION_STATUS_DECLARATION, INSTALLATION_TRANSITIONS],
} as const;

describe("the declared machines", () => {
  it.each(Object.entries(MACHINES))(
    "%s: every declared status has a transition row naming only declared statuses",
    (_name, [declaration, transitions]) => {
      expect(Object.keys(transitions).sort()).toEqual(
        Object.keys(declaration).sort()
      );
      for (const [from, tos] of Object.entries(transitions)) {
        for (const to of tos as readonly string[]) {
          expect(Object.keys(declaration)).toContain(to);
        }
        expect(from in declaration).toBe(true);
      }
    }
  );

  it("an archived automation comes back only through activation", () => {
    expect(
      statusesThatMayBecome(AUTOMATION_TRANSITIONS, "paused")
    ).not.toContain("archived");
    expect(canTransition(AUTOMATION_TRANSITIONS, "archived", "active")).toBe(
      true
    );
  });

  it("a policy block is a wait on a rule, not a failure", () => {
    expect(AUTOMATION_RUN_STATUS_DECLARATION.blocked_by_policy.category).toBe(
      "paused"
    );
  });

  it("an open step is one in the active or paused category", () => {
    expect([...OPEN_STAGE_RUN_STATUSES]).toEqual([
      "running",
      "waiting_tools",
      "waiting_child",
      "waiting_start",
      "unreached",
    ]);
  });
});

describe("automationStatusAtCreate — the one birth decision", () => {
  it("a person's approval activates; a stated status is kept", () => {
    expect(
      automationStatusAtCreate({
        requested: undefined,
        personApproved: true,
        actorIsAgent: true,
      })
    ).toBe("active");
    expect(
      automationStatusAtCreate({
        requested: "draft",
        personApproved: true,
        actorIsAgent: true,
      })
    ).toBe("draft");
  });

  it("an agent's automation no person approved is born draft", () => {
    expect(
      automationStatusAtCreate({
        requested: "active",
        personApproved: false,
        actorIsAgent: true,
      })
    ).toBe("draft");
  });

  it("a person's own create keeps its status, draft when none", () => {
    expect(
      automationStatusAtCreate({
        requested: "active",
        personApproved: false,
        actorIsAgent: false,
      })
    ).toBe("active");
    expect(
      automationStatusAtCreate({
        requested: undefined,
        personApproved: false,
        actorIsAgent: false,
      })
    ).toBe("draft");
  });
});
