/**
 * Pending-rule visibility — the PURE half of the floor.
 *
 * `listPendingRuleProposals` composes two floors: a SQL predicate
 * (`userVisibleWhere`, exercised wherever `proposals.list` is) and the scope
 * tiers below. The scope tiers are where a proposed rule could leak to someone
 * who would never have been allowed to see the materialized `skills` row, so
 * they are pinned here with no database in the loop.
 */
import { describe, it, expect } from "vitest";

import { readRulePayload, scopeVisibleToCaller } from "./pending-rules.js";

describe("readRulePayload", () => {
  it("reads the payload createRuleGoverned stores", () => {
    const p = readRulePayload({
      id: "rule-1",
      intent: "Always CC me on invoices",
      scope: { kind: "workspace", workspaceId: "ws-1" },
      trust: "auto",
      factSkillId: "skill-1",
      automationIds: ["a-1", "a-2"],
      auditSource: "rules.createRule",
    });
    expect(p).toEqual({
      id: "rule-1",
      intent: "Always CC me on invoices",
      scope: { kind: "workspace", workspaceId: "ws-1" },
      trust: "auto",
      factSkillId: "skill-1",
      automationIds: ["a-1", "a-2"],
    });
  });

  it("rejects a payload with no intent — there is no rule to show", () => {
    expect(readRulePayload({ id: "x" })).toBeNull();
    expect(readRulePayload({ intent: "   " })).toBeNull();
    expect(readRulePayload(null)).toBeNull();
    expect(readRulePayload("nope")).toBeNull();
  });

  it("defaults an unrecognised scope kind to pod and a bad trust to propose", () => {
    const p = readRulePayload({
      intent: "x",
      scope: { kind: "galaxy" },
      trust: "yolo",
    });
    expect(p?.scope.kind).toBe("pod");
    expect(p?.trust).toBe("propose");
  });

  it("drops non-string automation ids rather than trusting the blob", () => {
    const p = readRulePayload({ intent: "x", automationIds: ["a", 7, null] });
    expect(p?.automationIds).toEqual(["a"]);
  });
});

describe("scopeVisibleToCaller — visibleSkillsWhere's tiers, on a proposal", () => {
  it("pod-scoped: shared, exactly like a pod skill", () => {
    expect(scopeVisibleToCaller({ kind: "pod" }, "me", "someone-else")).toBe(
      true
    );
  });

  it("user-scoped: ONLY the proposer — another user's pending rule is invisible", () => {
    expect(scopeVisibleToCaller({ kind: "user" }, "me", "me")).toBe(true);
    expect(scopeVisibleToCaller({ kind: "user" }, "me", "someone-else")).toBe(
      false
    );
    // An unattributed proposal is nobody's — it must not fall open.
    expect(scopeVisibleToCaller({ kind: "user" }, "me", null)).toBe(false);
  });

  it("workspace-scoped: only under that workspace lens", () => {
    const scope = { kind: "workspace" as const, workspaceId: "ws-1" };
    expect(scopeVisibleToCaller(scope, "me", "me", "ws-1")).toBe(true);
    expect(scopeVisibleToCaller(scope, "me", "me", "ws-2")).toBe(false);
    // No lens selected ⇒ hidden, matching `visibleSkillsWhere(userId)` with no
    // workspaceId, which omits workspace-scoped rows entirely.
    expect(scopeVisibleToCaller(scope, "me", "me")).toBe(false);
  });
});
