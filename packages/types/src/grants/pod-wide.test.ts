/**
 * The ONE rule for what an app may hold with no space (`isPodWideReadPermission`). Widened on 2026-11-09 from
 * `entity.<kind>.read` to also `entity.read` and the plain read of a closed list of subjects, so the Chat app's
 * playbooks, runs, views and documents are no longer invisible to a grant limited to spaces. The rule's other half is
 * what stays out: nothing that writes, acts or means "every verb".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  POD_WIDE_READ_SUBJECTS,
  isPodWideReadPermission,
  isPodWideReadScope,
} from "./pod-wide.js";

describe("isPodWideReadPermission", () => {
  it("accepts a read of one named kind (decision e1b59d38 B, unchanged)", () => {
    for (const p of [
      "entity.decision.read",
      "entity.task.read",
      "entity.a-b_c1.read",
    ])
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
      for (const verb of [
        "create",
        "update",
        "delete",
        "run",
        "approve",
        "transition",
        "stream",
        "*",
      ])
        expect(
          isPodWideReadPermission(`${subject}.${verb}`),
          `${subject}.${verb}`
        ).toBe(false);
      expect(isPodWideReadPermission(subject), `${subject} (every verb)`).toBe(
        false
      );
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

// The rule is ONE regex literal (the SDK's tripwire reads it from the source), and the exported list is what docs and
// callers read: they must be the same set, in both directions. Read from the source so a subject added to one and
// not the other is red; the extraction itself is asserted so this cannot go vacuous.
describe("POD_WIDE_READ_SUBJECTS is the regex's subject alternation", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "pod-wide.ts"),
    "utf8"
  );
  const fn = src.slice(src.indexOf("export function isPodWideReadPermission"));
  const alternation = /\(\?:([a-z_|]+)\)\\\.read\)\$/.exec(fn)?.[1];

  it("finds the alternation in the source", () => {
    expect(
      alternation,
      "the subject alternation in isPodWideReadPermission"
    ).toBeDefined();
    expect(alternation!.split("|").length).toBeGreaterThanOrEqual(9);
  });

  it("lists exactly the exported subjects", () => {
    expect([...alternation!.split("|")].sort()).toEqual(
      [...POD_WIDE_READ_SUBJECTS].sort()
    );
  });
});

describe("isPodWideReadScope", () => {
  const scope = (permissions: string[], extra = {}) => ({
    permissions,
    ...extra,
  });

  it("is a scope with no space, project or object limit whose every permission is a pod-wide read", () => {
    expect(isPodWideReadScope(scope(["playbook.read", "entity.read"]))).toBe(
      true
    );
  });

  it("is not one when a single permission writes, or when it names a space", () => {
    expect(isPodWideReadScope(scope(["playbook.read", "playbook.run"]))).toBe(
      false
    );
    expect(
      isPodWideReadScope(scope(["playbook.read"], { workspaceIds: ["w"] }))
    ).toBe(false);
    expect(isPodWideReadScope(scope([]))).toBe(false);
  });
});
