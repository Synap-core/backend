/**
 * `/approve-agent` — the agent inside its computer (0395, D6/D7): the page
 * names the computer, engine, job and OS user; a NEW agent is offered the
 * permission choice at the recommended one; an agent that already worked
 * keeps its own unless the person changes it.
 */
import { describe, expect, it } from "vitest";
import {
  approveWriteMode,
  shownWriteMode,
  viewAgentInComputer,
} from "./agent-in-computer";

const CRM = {
  agentType: "claude-code",
  agentName: "CRM worker",
  agentRole: "crm-worker",
  hostSeat: "antoine",
  computerName: "devbox",
};

describe("the agent inside its computer", () => {
  it("names the computer, the engine, the job and the OS user", () => {
    const v = viewAgentInComputer({ ...CRM, isNewAgent: true });
    expect(v).toMatchObject({
      name: "CRM worker · Claude Code on devbox",
      seat: 'OS user "antoine"',
      isNew: true,
      nothingElse: "Nothing else on devbox changes.",
    });
  });

  it("a new agent: the choice starts at Normal and is sent", () => {
    const v = viewAgentInComputer({ ...CRM, isNewAgent: true })!;
    expect(shownWriteMode(v, null)).toBe("pod-default");
    expect(approveWriteMode(v, null)).toBe("pod-default");
    expect(approveWriteMode(v, "ask-first")).toBe("ask-first");
  });

  it("an agent that already worked keeps its permission unless changed (D6)", () => {
    const v = viewAgentInComputer({
      ...CRM,
      isNewAgent: false,
      writeMode: "create-with-undo",
    })!;
    expect(v.currentModeLabel).toBe("Creates only");
    expect(shownWriteMode(v, null)).toBeNull();
    expect(approveWriteMode(v, null)).toBeUndefined();
    expect(approveWriteMode(v, "pod-default")).toBe("pod-default");
  });

  it("an agent on no computer (or an older pod's read): nothing is shown or sent", () => {
    const v = viewAgentInComputer({ agentType: "claude-code" });
    expect(v).toBeNull();
    expect(approveWriteMode(v, "ask-first")).toBeUndefined();
  });
});
