/**
 * `create-with-undo` is an OPTIONAL, STRICTER-ONLY per-agent preset on top of
 * the pod default "reversible writes act" (`@reversible`). These pin its
 * derivation from the reversibility class and that it can never loosen. The
 * end-to-end decisions (writer → store → resolver, with and without the pod
 * row) are pinned in @synap/database `agent-posture.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  REVERSIBLE_EVENT_KEYS,
  decideAgentPolicy,
  isReversibleWrite,
} from "./index.js";
import { classifyFloorEntry, resolveAgentPosture } from "./postures.js";

describe("create-with-undo (stricter preset)", () => {
  const posture = resolveAgentPosture("create-with-undo");

  it("never loosens: rung 5 stays strict and it widens nothing", () => {
    expect(posture.writesRequireProposal).toBe(true);
    expect(posture.autoApproveFor).toEqual([]);
  });

  it("proposes exactly the reversible writes that are edits — derived from the class", () => {
    // Non-vacuity: the class really carries edits today.
    expect(posture.proposeFor).toEqual(
      expect.arrayContaining([
        "entity.update",
        "facet.update",
        "facet.detach",
        "document.update",
      ])
    );
    for (const k of REVERSIBLE_EVENT_KEYS) {
      expect(posture.proposeFor.includes(k), k).toBe(
        classifyFloorEntry(k) === "write"
      );
    }
    // It only ever takes back pod-default lanes, never names a disruptive key.
    for (const k of posture.proposeFor)
      expect(isReversibleWrite(k), k).toBe(true);
  });

  it("keeps creates and the agent's own orchestration on the direct lane", () => {
    for (const p of [
      "entity.create",
      "document.create",
      "relation.create",
      "facet.attach",
      "focus_session.update",
      "playbook_run.update",
      "track.update",
    ])
      expect(posture.proposeFor, p).not.toContain(p);
  });

  it("with the pod default AND the preset, the ENGINE agrees: creates execute, edits propose, deletes floor", () => {
    const run = (subjectType: string, action: string) => {
      const key = `${subjectType}.${action}`;
      return decideAgentPolicy({
        subjectType,
        action,
        writesRequireProposal: posture.writesRequireProposal,
        // Most specific row wins: the agent's own propose row over the pod class row.
        governanceRuleVerdict: posture.proposeFor.includes(key)
          ? "propose"
          : isReversibleWrite(key)
            ? "auto"
            : undefined,
      }).verdict;
    };
    expect(run("entity", "create")).toBe("execute");
    expect(run("entity", "update")).toBe("propose");
    expect(run("entity", "delete")).toBe("propose");
    expect(run("property_def", "create")).toBe("propose");
  });
});
