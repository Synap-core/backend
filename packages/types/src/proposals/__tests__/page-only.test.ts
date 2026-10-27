/**
 * Which proposals only their own page may approve, read from the WIRE shape
 * the pod stores (`proposals.data`: the request under `data`, the duplicate
 * answer at the top).
 *
 * Rows that rule out a wrong rule:
 *  - a `builtin` kind is executable: rules out pod-admin's first copy
 *    (`kind` code|declarative only);
 *  - an explicit `instruction` kind is not, even carrying a `code` string:
 *    rules out "any code string means code";
 *  - no `kind` with blank code is not: rules out "a code key means code";
 *  - a skill UPDATE and a tool create with code are not: rules out reading
 *    the payload without the verb or the target;
 *  - a pending-proposal twin is not page-only, a record twin is: rules out
 *    "any duplicate answer".
 */
import { describe, expect, it } from "vitest";
import {
  isExecutableSkillCreate,
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
      isExecutableSkillCreate(
        skillCreate({ name: "s", kind: "instruction", code: "return 1;" })
      )
    ).toBe(false);
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

  it("an instruction skill and a plain create may be batched", () => {
    expect(
      proposalNeedsItsPage(skillCreate({ name: "s", kind: "instruction" }))
    ).toBe(false);
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
