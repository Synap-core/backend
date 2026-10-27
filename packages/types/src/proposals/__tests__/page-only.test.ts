/**
 * Which proposals only their own page may approve, read from the WIRE shape
 * the pod stores (`proposals.data`: the request under `data`, the duplicate
 * answer at the top).
 *
 * Rows that rule out a wrong rule:
 *  - a `builtin` kind is executable: rules out pod-admin's first copy
 *    (`kind` code|declarative only);
 *  - an explicit `instruction` kind carrying a `code` string IS executable:
 *    rules out "the label decides" (the runtime evaluates any code it finds);
 *  - no `kind` with blank code is not: rules out "a code key means code";
 *  - a skill UPDATE and a tool create with code are not executable: rules out
 *    reading the payload without the verb or the target;
 *  - an instruction skill create, a skill update and a composite carrying a
 *    skill, automation or rule act on their own; a composite of records does
 *    not: rules out "only code needs the page" and "every composite";
 *  - a pending-proposal twin is not page-only, a record twin is: rules out
 *    "any duplicate answer".
 */
import { describe, expect, it } from "vitest";
import {
  isExecutableSkillCreate,
  pageOnlyReasonActs,
  proposalNeedsItsPage,
  proposalPageOnlyReason,
} from "../page-only.js";
import type { DuplicateCandidate } from "../duplicate-check.js";

const skillCreate = (request: Record<string, unknown>, extra = {}) => ({
  targetType: "skill",
  proposalType: "create",
  data: { requestId: "r-1", changeType: "create", data: request, ...extra },
});

const twin = (ref: "record" | "proposal"): DuplicateCandidate => ({
  ref,
  id: `${ref}-ada`,
  kind: "person",
  title: "Ada Lovelace",
  why: "same_name",
});

const entityCreate = (candidates: DuplicateCandidate[]) => ({
  targetType: "entity",
  proposalType: "create",
  data: {
    requestId: "r-1",
    changeType: "create",
    data: { profileSlug: "person", title: "Ada Lovelace" },
    duplicateCheck: { status: "possible", subject: "entity", candidates },
  },
});

describe("isExecutableSkillCreate", () => {
  it("every kind but an instruction runs something", () => {
    for (const kind of ["code", "declarative", "builtin"]) {
      expect(isExecutableSkillCreate(skillCreate({ name: "s", kind }))).toBe(
        true
      );
    }
    expect(
      isExecutableSkillCreate(skillCreate({ name: "s", kind: "instruction" }))
    ).toBe(false);
  });

  it("code runs whatever the kind says", () => {
    expect(
      isExecutableSkillCreate(
        skillCreate({ name: "s", kind: "instruction", code: "return 1;" })
      )
    ).toBe(true);
    expect(
      isExecutableSkillCreate(
        skillCreate({
          name: "s",
          kind: "instruction",
          providerSpec: { tool: "apify" },
        })
      )
    ).toBe(true);
  });

  it("with no kind, it is read by what it carries", () => {
    expect(
      isExecutableSkillCreate(skillCreate({ name: "s", code: "return 1;" }))
    ).toBe(true);
    expect(
      isExecutableSkillCreate(
        skillCreate({ name: "s", providerSpec: { tool: "apify" } })
      )
    ).toBe(true);
    expect(
      isExecutableSkillCreate(skillCreate({ name: "s", code: "  " }))
    ).toBe(false);
    expect(
      isExecutableSkillCreate(skillCreate({ name: "s", body: "Do X" }))
    ).toBe(false);
  });

  it("reads a flat payload and a dotted verb", () => {
    expect(
      isExecutableSkillCreate({
        targetType: "skill",
        proposalType: "skill.create",
        data: { kind: "code", code: "return 1;" },
      })
    ).toBe(true);
  });

  it("never a skill update, never another target", () => {
    expect(
      isExecutableSkillCreate({
        ...skillCreate({ kind: "code", code: "return 1;" }),
        proposalType: "update",
      })
    ).toBe(false);
    expect(
      isExecutableSkillCreate({
        ...skillCreate({ kind: "code", code: "return 1;" }),
        targetType: "tool",
      })
    ).toBe(false);
  });
});

describe("proposalPageOnlyReason", () => {
  it("a skill that runs code is decided on its page", () => {
    const p = skillCreate({ name: "s", kind: "code", code: "return 1;" });
    expect(proposalPageOnlyReason(p)).toBe("executable_skill");
    expect(proposalNeedsItsPage(p)).toBe(true);
  });

  it("a create whose twin is a record waits for the person's choice", () => {
    expect(proposalPageOnlyReason(entityCreate([twin("record")]))).toBe(
      "identity_choice"
    );
  });

  it("a twin that is another pending proposal is a door, not a page-only", () => {
    expect(proposalPageOnlyReason(entityCreate([twin("proposal")]))).toBeNull();
  });

  it("a plain create may be batched", () => {
    expect(
      proposalNeedsItsPage({
        targetType: "entity",
        proposalType: "create",
        data: { data: { title: "x" } },
      })
    ).toBe(false);
  });

  it("code wins over a twin: its page is the one review either way", () => {
    expect(
      proposalPageOnlyReason(
        skillCreate(
          { name: "s", kind: "code", code: "return 1;" },
          {
            duplicateCheck: {
              status: "possible",
              subject: "entity",
              candidates: [twin("record")],
            },
          }
        )
      )
    ).toBe("executable_skill");
  });
});

const composite = (ops: Array<Record<string, unknown>>) => ({
  targetType: "entity",
  proposalType: "capture.graph",
  data: { operations: ops },
});

const entityOp = { op: "create_entity", profileSlug: "note", title: "x" };

describe("acts_on_its_own", () => {
  it("an instruction skill create: its prose lands in an agent's prompt", () => {
    const p = skillCreate({ name: "s", kind: "instruction", body: "Do X" });
    expect(proposalPageOnlyReason(p)).toBe("acts_on_its_own");
  });

  it("any skill update, whatever it patches", () => {
    for (const proposalType of ["update", "skill.update"]) {
      expect(
        proposalPageOnlyReason({
          targetType: "skill",
          proposalType,
          data: { data: { id: "s-1", description: "x" } },
        })
      ).toBe("acts_on_its_own");
    }
  });

  it("a composite carrying a skill, an automation or a rule", () => {
    for (const op of [
      "create_skill",
      "create_automation",
      "create_rule",
      "update_skill",
      "update_automation",
      "update_rule",
    ]) {
      expect(
        proposalPageOnlyReason(composite([entityOp, { op, ref: "a" }]))
      ).toBe("acts_on_its_own");
    }
  });

  it("reads the ops one level down too (a client row rebuilt from its request)", () => {
    const ops = [entityOp, { op: "create_rule", ref: "r" }];
    expect(
      proposalPageOnlyReason({
        targetType: "entity",
        proposalType: "create",
        data: { data: { operations: ops } },
      })
    ).toBe("acts_on_its_own");
  });

  it("a composite of records only, and a skill delete, may be batched", () => {
    expect(
      proposalPageOnlyReason(
        composite([entityOp, { op: "update_view", ref: "v", viewId: "v-1" }])
      )
    ).toBeNull();
    expect(
      proposalPageOnlyReason({
        targetType: "skill",
        proposalType: "delete",
        data: { data: { id: "s-1" } },
      })
    ).toBeNull();
  });

  it("the acting reasons are the two whose approval turns something on", () => {
    expect(pageOnlyReasonActs("executable_skill")).toBe(true);
    expect(pageOnlyReasonActs("acts_on_its_own")).toBe(true);
    expect(pageOnlyReasonActs("identity_choice")).toBe(false);
    expect(pageOnlyReasonActs(null)).toBe(false);
  });
});
