import { describe, expect, it } from "vitest";
import { runFilingOfFlow } from "../run-filing.js";

const P = "77777777-7777-4777-8777-777777777777";
const T = "99999999-9999-4999-8999-999999999991";

describe("runFilingOfFlow — an automation run lands in its worker's goal (R3)", () => {
  it("a playbook_run node filed on a goal files the run there", () => {
    expect(
      runFilingOfFlow({
        nodes: [
          { type: "trigger", data: {} },
          { type: "loop", data: {} },
          { type: "playbook_run", data: { projectId: P, trackId: T } },
        ],
      })
    ).toEqual({ projectId: P, trackId: T });
  });

  it("two goals, or a goal without its project, file no goal", () => {
    expect(
      runFilingOfFlow({
        nodes: [
          { type: "playbook_run", data: { projectId: P, trackId: T } },
          { type: "playbook_run", data: { projectId: P, trackId: "other" } },
        ],
      })
    ).toEqual({ projectId: P, trackId: null });
    expect(
      runFilingOfFlow({
        nodes: [{ type: "playbook_run", data: { trackId: T } }],
      })
    ).toEqual({ projectId: null, trackId: null });
  });

  it("a flow with no playbook_run files nothing", () => {
    expect(
      runFilingOfFlow({
        nodes: [{ type: "send_message", data: { trackId: T } }],
      })
    ).toEqual({ projectId: null, trackId: null });
  });
});
