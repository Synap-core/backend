/**
 * `create-with-undo` (D2) is DERIVED from the platform floor — these pin the
 * derivation, and prove a write key added to the floor joins the propose set
 * by existing. The end-to-end decisions (writer → store → resolver) are pinned
 * in @synap/database `agent-posture.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_AUTO_APPROVE, decideAgentPolicy } from "./index.js";
import {
  classifyFloorEntry,
  resolveAgentPosture,
  DEFAULT_NEW_AGENT_POSTURE,
} from "./postures.js";

describe("create-with-undo", () => {
  const posture = resolveAgentPosture("create-with-undo");

  it("is the new-agent default and does not require proposals wholesale", () => {
    expect(DEFAULT_NEW_AGENT_POSTURE).toBe("create-with-undo");
    expect(posture.writesRequireProposal).toBe(false);
  });

  it("proposes every floor WRITE that is not a create — and only those", () => {
    // Non-vacuity: the floor really carries non-create writes today.
    expect(posture.proposeFor).toEqual(
      expect.arrayContaining(["entity.update", "facet.update", "facet.detach"])
    );
    for (const p of DEFAULT_AUTO_APPROVE) {
      const kind = classifyFloorEntry(p);
      expect(posture.proposeFor.includes(p), p).toBe(kind === "write");
    }
  });

  it("never proposes a create, a read, or the agent's own session work", () => {
    for (const p of [
      "entity.create",
      "document.create",
      "relation.create",
      "facet.attach",
      "entity.read",
      "search.*",
      "terminal.read_logs",
      "focus_session.update",
    ])
      expect(posture.proposeFor, p).not.toContain(p);
  });

  it("a new non-create write on the floor would be proposed by existing (derived, not listed)", () => {
    expect(classifyFloorEntry("widget.update")).toBe("write");
    expect(classifyFloorEntry("widget.create")).toBe("create");
  });

  it("with its rule verdicts, the ENGINE agrees: creates execute, updates propose, deletes floor", () => {
    const run = (subjectType: string, action: string) =>
      decideAgentPolicy({
        subjectType,
        action,
        writesRequireProposal: posture.writesRequireProposal,
        governanceRuleVerdict: posture.proposeFor.includes(
          `${subjectType}.${action}`
        )
          ? "propose"
          : undefined,
      }).verdict;
    expect(run("entity", "create")).toBe("execute");
    expect(run("entity", "update")).toBe("propose");
    expect(run("entity", "delete")).toBe("propose");
    expect(run("property_def", "create")).toBe("propose");
  });
});
