import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

import {
  checkVerbParameters,
  describeParameterRepair,
} from "./validate-verb-parameters.js";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";

/**
 * Arguments are checked against the verb's DECLARED schema BEFORE a proposal is
 * filed — and a verb that declares nothing is never rejected for it.
 *
 * The filed defect: `entity.delete` called with `{"entityIds":[…]}` (plural,
 * undeclared) filed proposal 81417965-cf1d-456c-8149-d747ba9115fb with no
 * schema error, so the human's approval was spent before anyone knew whether
 * the call could work.
 */

const UUID = "33333333-3333-4333-8333-333333333333";

describe("builtin verbs validate against the HANDLER's own Zod schema", () => {
  it("the SSOT this reads is the one the coherence tripwire holds the catalog to", () => {
    // Non-vacuity: the source exists and carries the verb under test, so a
    // rename cannot turn every case below into a silent `unvalidated`.
    expect(BUILTIN_VERB_PARAM_SCHEMAS["entity.delete"]).toBeDefined();
    expect(Object.keys(BUILTIN_VERB_PARAM_SCHEMAS).length).toBeGreaterThan(20);
  });

  it("THE FILED CASE: entity.delete({entityIds:[…]}) is invalid, with a repair", () => {
    const check = checkVerbParameters(
      { kind: "builtin", name: "entity.delete" },
      { entityIds: [UUID] }
    );
    expect(check).toEqual({
      status: "invalid",
      repair: {
        missing: ["entityId"],
        wrongType: {},
        unknown: ["entityIds"],
      },
    });
    // The human half names both halves of the mistake.
    if (check.status !== "invalid") throw new Error("unreachable");
    const msg = describeParameterRepair("entity.delete", check.repair);
    expect(msg).toContain("entityId");
    expect(msg).toContain("entityIds");
    expect(msg).toContain("Nothing was proposed or run");
  });

  it("the correct call passes", () => {
    expect(
      checkVerbParameters(
        { kind: "builtin", name: "entity.delete" },
        { entityId: UUID }
      )
    ).toEqual({ status: "ok", unknown: [] });
  });

  it("a WRONG TYPE is reported as wrongType, not as missing", () => {
    const check = checkVerbParameters(
      { kind: "builtin", name: "entity.delete" },
      { entityId: 42 }
    );
    expect(check).toEqual({
      status: "invalid",
      repair: {
        missing: [],
        wrongType: { entityId: { expected: "string", received: "number" } },
        unknown: [],
      },
    });
  });

  it("a FORMAT failure names the format (`uuid`), not the issue code", () => {
    const check = checkVerbParameters(
      { kind: "builtin", name: "entity.delete" },
      { entityId: "not-a-uuid" }
    );
    expect(check).toMatchObject({
      status: "invalid",
      repair: { wrongType: { entityId: { expected: "uuid" } } },
    });
  });

  it("a builtin with NO registered schema is unvalidated, never rejected", () => {
    // `feed.read` parses inline and is deliberately absent from the registry.
    expect(BUILTIN_VERB_PARAM_SCHEMAS["feed.read"]).toBeUndefined();
    expect(
      checkVerbParameters(
        { kind: "builtin", name: "feed.read" },
        { anything: 1 }
      )
    ).toEqual({ status: "unvalidated", reason: "no_declared_schema" });
  });
});

describe("non-builtin verbs validate against skills.parameters (the catalog's argsSchema)", () => {
  // The dialect measured across the Control Plane's capability templates.
  const declared = {
    uid: "string",
    count: "number?",
    flags: "array",
    payload: "object?",
    weird: "date", // a type this module does not know
  };
  const skill = { kind: "declarative", name: "cal_x", parameters: declared };

  it("required absent → missing; optional absent → fine", () => {
    const check = checkVerbParameters(skill, { flags: [] });
    expect(check).toEqual({
      status: "invalid",
      repair: { missing: ["uid"], wrongType: {}, unknown: [] },
    });
  });

  it("array and object are distinguished from bare `typeof`", () => {
    const check = checkVerbParameters(skill, {
      uid: "u",
      flags: { not: "an array" },
      payload: ["not an object"],
    });
    expect(check).toMatchObject({
      status: "invalid",
      repair: {
        wrongType: {
          flags: { expected: "array", received: "object" },
          payload: { expected: "object", received: "array" },
        },
      },
    });
  });

  it("an unknown-typed field is skipped ENTIRELY — absent is not reported missing", () => {
    // `weird: "date"` has no `?`, so a naive reading calls it required. Acting
    // on half a declaration we do not understand is a FALSE REJECTION; the
    // miss is the cheaper error. (This assertion is why the code skips the
    // field before the requiredness check, not after.)
    const check = checkVerbParameters(skill, { uid: "u", flags: [] });
    expect(check).toEqual({ status: "ok", unknown: [] });
  });

  it("a declared type this module cannot read makes that FIELD unverifiable, not the call", () => {
    expect(
      checkVerbParameters(skill, { uid: "u", flags: [], weird: 12345 })
    ).toEqual({ status: "ok", unknown: [] });
  });

  it("an UNKNOWN key alone is reported but never rejects", () => {
    expect(
      checkVerbParameters(skill, { uid: "u", flags: [], surprise: 1 })
    ).toEqual({ status: "ok", unknown: ["surprise"] });
  });
});

describe("ABSENT schema means cannot-validate, never no-arguments-allowed", () => {
  for (const [label, parameters] of [
    ["undefined", undefined],
    ["null", null],
    ["empty object", {}],
    ["an array (not a map)", ["uid"]],
    ["a string", "uid: string"],
  ] as Array<[string, unknown]>) {
    it(`${label} → unvalidated even with arguments passed`, () => {
      expect(
        checkVerbParameters(
          { kind: "code", name: "exa_search", parameters },
          { query: "synap", extra: true }
        )
      ).toEqual({ status: "unvalidated", reason: "no_declared_schema" });
    });
  }

  it("a call with NO arguments against a schema with no required fields is fine", () => {
    expect(
      checkVerbParameters(
        { kind: "declarative", name: "cal_list", parameters: { q: "string?" } },
        undefined
      )
    ).toEqual({ status: "ok", unknown: [] });
  });
});

// ── The SEAM: the check runs BEFORE the proposal is filed ─────────────────────

describe("guard: executeCapability validates before it proposes", () => {
  const src = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "execute-capability.ts"),
    "utf8"
  );

  it("the declared schema column is SELECTED (without it every verb reads unvalidated)", () => {
    expect(src).toMatch(/parameters:\s*skills\.parameters/);
  });

  it("checkVerbParameters is called inside the propose branch, before createPendingProposal", () => {
    const branch = src.indexOf('if (decision.decision === "propose")');
    const check = src.indexOf("checkVerbParameters(", branch);
    const file = src.indexOf("createPendingProposal(", branch);
    expect(branch).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(branch);
    expect(file).toBeGreaterThan(check); // ORDER is the whole point
  });

  it("the refusal carries the STRUCTURED repair, not just a message", () => {
    expect(src).toMatch(
      /kind:\s*"error",\s*message,\s*repair:\s*paramCheck\.repair/
    );
  });
});

/**
 * WHAT THIS DOES NOT COVER, measured.
 *
 * - `executeCapability` end to end. The gate + db select are not driven here,
 *   so the ORDER claim above is a source guard, not a behavioural one: it
 *   would not catch a refactor that moved the check into a branch that never
 *   runs. Verified by reverting the `return { kind: "error" … }` to a fallthrough
 *   and watching the two unit describes stay green (only the seam test moves).
 * - The RUN path is intentionally unvalidated here — a run reaches the handler's
 *   own `parse()`. Nothing in this file asserts that, because nothing changed
 *   there.
 * - NESTED fields: a Zod issue inside an object property reports its dotted
 *   path, but the type-map dialect is flat by construction, so nested
 *   validation exists only for builtins.
 */
