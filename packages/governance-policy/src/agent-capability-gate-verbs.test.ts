/**
 * Founder decision 2026-10-11, agent side: a legacy `subject.*` capability
 * covers read/create/update/delete only; `*.*` stays every verb. Each case
 * names the rule it rules out.
 */
import { describe, expect, it } from "vitest";
import { agentHasCapability } from "./index.js";

describe("agentHasCapability — gate verbs must be named", () => {
  // Rules out: the legacy `subject.*` short-circuit widening to every verb.
  it("subject.* covers the four catalog actions, not approve or merge", () => {
    expect(
      agentHasCapability("proposal.update", "proposal", ["proposal.*"])
    ).toBe(true);
    expect(
      agentHasCapability("proposal.approve", "proposal", ["proposal.*"])
    ).toBe(false);
    expect(
      agentHasCapability("entity.merge", "entity", ["entity.*"], "note")
    ).toBe(false);
    expect(agentHasCapability("playbook.run", "playbook", ["playbook.*"])).toBe(
      false
    );
  });
  // Rules out: a bare grant pattern carrying gate verbs via the prefix rule.
  it("a bare subject or kind does not approve or merge", () => {
    expect(
      agentHasCapability("proposal.approve", "proposal", ["proposal"])
    ).toBe(false);
    expect(
      agentHasCapability("entity.merge", "entity", ["entity.note"], "note")
    ).toBe(false);
  });
  it("a named verb does", () => {
    expect(
      agentHasCapability("proposal.approve", "proposal", ["proposal.approve"])
    ).toBe(true);
    expect(
      agentHasCapability(
        "entity.merge",
        "entity",
        ["entity.note.merge"],
        "note"
      )
    ).toBe(true);
    expect(
      agentHasCapability("entity.merge", "entity", ["entity.merge"], "task")
    ).toBe(true);
  });
  // Rules out: `*.*` narrowed along with `subject.*`.
  it("*.* and * stay every verb", () => {
    expect(agentHasCapability("proposal.approve", "proposal", ["*.*"])).toBe(
      true
    );
    expect(agentHasCapability("entity.merge", "entity", ["*"], "note")).toBe(
      true
    );
  });
  // Rules out: the capability rung reading the raw door name while the key
  // grant reads the grammar spelling (P2 listed focus_session as a workaround).
  it("reads a door in the grant grammar's spelling (grantRequestKey)", () => {
    expect(
      agentHasCapability("focus_session.create", "focus_session", [
        "session.create",
      ])
    ).toBe(true);
    expect(
      agentHasCapability("view.updateContent", "view", ["view.update_content"])
    ).toBe(true);
    expect(
      agentHasCapability("relationDef.create", "relationDef", [
        "relation_def.create",
      ])
    ).toBe(true);
    expect(
      agentHasCapability(
        "entity.renderer.set",
        "entity",
        ["entity.*.renderer_set"],
        "note"
      )
    ).toBe(true);
    // A bare subject still names no gate verb, folded or not.
    expect(agentHasCapability("view.updateContent", "view", ["view"])).toBe(
      false
    );
  });
});
