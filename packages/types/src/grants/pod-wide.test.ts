/**
 * The ONE rule for what an app may hold with no space (`isPodWideReadPermission`). Widened on 2026-11-09 from
 * `entity.<kind>.read` to also `entity.read` and the plain read of a closed list of subjects, so the Chat app's
 * playbooks, runs, views and documents are no longer invisible to a grant limited to spaces. The rule's other half is
 * what stays out: nothing that writes, acts or means "every verb".
 */
import { describe, expect, it } from "vitest";
import {
  POD_WIDE_READ_SUBJECTS,
  isPodWideReadPermission,
  isPodWideReadScope,
} from "./pod-wide.js";

describe("isPodWideReadPermission", () => {
  it("accepts a read of one named kind (decision e1b59d38 B, unchanged)", () => {
    for (const p of ["entity.decision.read", "entity.task.read", "entity.a-b_c1.read"])
      expect(isPodWideReadPermission(p), p).toBe(true);
  });

  it("accepts every kind, and the plain read of each listed subject", () => {
    expect(isPodWideReadPermission("entity.read")).toBe(true);
    for (const subject of POD_WIDE_READ_SUBJECTS)
      expect(isPodWideReadPermission(`${subject}.read`), subject).toBe(true);
  });

  it("is a closed list of READS: no listed subject admits a verb, and the list has a floor", () => {
    expect(POD_WIDE_READ_SUBJECTS.length).toBeGreaterThanOrEqual(9);
    for (const subject of POD_WIDE_READ_SUBJECTS) {
      for (const verb of ["create", "update", "delete", "run", "approve", "transition", "stream", "*"])
        expect(isPodWideReadPermission(`${subject}.${verb}`), `${subject}.${verb}`).toBe(false);
      expect(isPodWideReadPermission(subject), `${subject} (every verb)`).toBe(false);
    }
  });

  it("refuses what must stay per space or never be held", () => {
    for (const p of [
      "*",
      "entity.*.read",
      "entity.decision",
      "entity.decision.update",
      "entity.deal.transition",
      "chat.stream",
      "playbook.run",
      "agent.read",
      "key.read",
      "grant.read",
      "ai_provider.read",
      "",
      "read",
      ".read",
      "playbook.read.extra",
      "PLAYBOOK.read",
    ])
      expect(isPodWideReadPermission(p), JSON.stringify(p)).toBe(false);
  });
});

describe("isPodWideReadScope", () => {
  const scope = (permissions: string[], extra = {}) => ({ permissions, ...extra });

  it("is a scope with no space, project or object limit whose every permission is a pod-wide read", () => {
    expect(isPodWideReadScope(scope(["playbook.read", "entity.read"]))).toBe(true);
  });

  it("is not one when a single permission writes, or when it names a space", () => {
    expect(isPodWideReadScope(scope(["playbook.read", "playbook.run"]))).toBe(false);
    expect(isPodWideReadScope(scope(["playbook.read"], { workspaceIds: ["w"] }))).toBe(false);
    expect(isPodWideReadScope(scope([]))).toBe(false);
  });
});
