/**
 * THE DRAFT FAIL-CLOSED PROPERTY.
 *
 * ── The hazard this pins ────────────────────────────────────────────────────
 * Every automation product surveyed for this wave lets an incomplete rule EXIST
 * with visible holes, because in those products a hole is SAFE: the automation
 * is inert until switched on. Ours is NOT symmetrical. Three of the nine WHERE
 * operators (`UNEVALUABLE_CONDITION_OPERATORS` — `contains`, `starts_with`,
 * `changed_to`) have no runtime equivalent, and `toBackendTrigger` folds with
 * `if (compiled !== undefined)`, so an unresolved predicate is DROPPED — which
 * WIDENS the rule rather than narrowing it. A "draft" automation carrying a
 * widened filter is one `status → active` flip away from firing on exactly the
 * events its author had just excluded, and that flip is reachable from
 * `automations.update` and from any UI toggle, none of which recompile.
 *
 * So the draft state is defined as an ABSENCE, and this file is what holds that
 * definition honest. It asserts three things, for EVERY unevaluable operator:
 *
 *   1. the draft SAVES (that is the founder's requirement — the rule exists),
 *   2. it materializes ZERO automations (the interlock: there is no artifact to
 *      arm, so inertness cannot be undone by a flag flip), and
 *   3. ACTIVATING it is REFUSED, naming the WHERE clause.
 *
 * ── Why it iterates the exported constant ───────────────────────────────────
 * Three hand-written cases would not cover a fourth operator the day the
 * grammar gains one — and a new sentence operator with no runtime evaluator is
 * precisely the change that would re-open this hole. Iterating
 * `UNEVALUABLE_CONDITION_OPERATORS` means a new member inherits the coverage
 * with no edit here. (Same reason `EVALUABLE_OPERATOR_OPTIONS` derives the
 * editor's menu from the same constant instead of re-listing it.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UNEVALUABLE_CONDITION_OPERATORS } from "@synap-core/types/automations";

const inserted: Array<Record<string, unknown>> = [];

/**
 * PARTIAL mock (`importOriginal`), never a total replacement — see
 * `__tripwires__/database-mock-total-ratchet.test.ts`. A hand-listed module
 * object dies at COLLECTION time the moment any file in the import graph starts
 * using an export it does not list, and the WHOLE FILE goes dark silently. This
 * file already proved the point: `services/rules/index.ts` gained `links` and
 * `and` while this was being written.
 */
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [{ id: values.id }] };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      delete: () => ({ where: async () => undefined }),
    },
  };
});

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async () => ({ allowed: true }),
}));

vi.mock("../links/links-service.js", () => ({
  createLinks: async () => undefined,
}));

/**
 * The ONE automation insert door. Recording its calls is the actual assertion:
 * "zero automations materialized" is a claim about a DOOR, and mocking the door
 * is how the claim gets checked rather than assumed.
 */
const materializeCalls: Array<Record<string, unknown>> = [];
vi.mock("../../routers/automations.js", () => ({
  materializeAutomationForPrincipal: async (args: Record<string, unknown>) => {
    materializeCalls.push(args);
    return "33333333-3333-3333-3333-333333333333";
  },
}));

const { createRuleGoverned } = await import("./create.js");
const { readRuleMetadata } = await import("./index.js");

/** WHEN an entity is created → THEN notify. Compiles cleanly on its own. */
const BASE_SENTENCE = {
  trigger: {
    triggerType: "event" as const,
    subjectCategory: "entity" as const,
    actionVerb: "created" as const,
  },
  conditions: [],
  actions: [{ type: "notify" as const, config: { message: "hi" } }],
};

/** The same sentence with ONE hole in its WHERE — the only variable. */
const withHole = (operator: string) => ({
  ...BASE_SENTENCE,
  conditions: [
    { id: "c1", key: "status", operator, value: "open" } as unknown as never,
  ],
});

const create = (over: Record<string, unknown>) =>
  createRuleGoverned({
    userId: "user-1",
    workspaceId: "ws-1",
    intent: "When an entity is created, notify me",
    scope: { kind: "pod" },
    ...over,
  } as Parameters<typeof createRuleGoverned>[0]);

beforeEach(() => {
  inserted.length = 0;
  materializeCalls.length = 0;
});

describe("a DRAFT rule with an unresolved predicate", () => {
  it("has operators to test (the constant is not empty)", () => {
    // A vacuous loop is a green test that checks nothing. If the grammar ever
    // gains a runtime evaluator for all three, this fails LOUDLY and the whole
    // draft rationale gets re-read rather than silently becoming untested.
    expect(UNEVALUABLE_CONDITION_OPERATORS.length).toBeGreaterThan(0);
  });

  for (const operator of UNEVALUABLE_CONDITION_OPERATORS) {
    describe(`operator "${operator}"`, () => {
      it("SAVES as a draft — the rule exists with its hole", async () => {
        const result = await create({
          draft: true,
          sentence: withHole(operator),
        });
        expect(result.status).toBe("created");
        const metadata = readRuleMetadata(
          (inserted.at(-1)?.metadata ?? {}) as Record<string, unknown>
        );
        expect(metadata?.draft).toBe(true);
        // The sentence is stored VERBATIM, holes included — activation has to
        // recompile it, so it must survive the save unmodified.
        expect(metadata?.sentence).toMatchObject({
          conditions: [{ operator }],
        });
      });

      it("materializes ZERO automations — inert by absence, not by flag", async () => {
        await create({ draft: true, sentence: withHole(operator) });
        // The interlock. Not "an automation exists with status draft" — NO
        // automation exists, so there is no row for the trigger matcher to
        // select and no status for a later edit to flip.
        expect(materializeCalls).toHaveLength(0);
      });

      it("is REFUSED on ACTIVATION, naming the WHERE clause", async () => {
        // Activation runs the same compiler this create path runs with
        // `draft: false`. The refusal is what makes the stored hole safe: it
        // can never become a live filter without passing here.
        const result = await create({
          draft: false,
          sentence: withHole(operator),
        });
        expect(result).toMatchObject({
          status: "denied",
          failure: { clause: "WHERE" },
        });
        expect(materializeCalls).toHaveLength(0);
        // Nothing was written either — a refused activation must not leave a
        // half-rule behind.
        expect(inserted).toHaveLength(0);
      });

      it("names the operator in the refusal, so the author can find the row", async () => {
        const result = await create({
          draft: false,
          sentence: withHole(operator),
        });
        expect(result.status).toBe("denied");
        if (result.status !== "denied") return;
        expect(result.reason).toContain(operator.replace(/_/g, " "));
      });
    });
  }
});

describe("a DRAFT rule with a HALF-FILLED condition", () => {
  // The other silent widener: `toBackendTrigger` folds only rows with BOTH a
  // key and a value, so a row missing either is dropped — the same widening,
  // reached by a different hole. A draft is exactly where a half-filled row
  // legitimately exists, which is why it must not compile.
  const halfFilled = {
    ...BASE_SENTENCE,
    conditions: [
      { id: "c1", key: "status", operator: "is", value: "" } as never,
    ],
  };

  it("SAVES with no automation", async () => {
    const result = await create({ draft: true, sentence: halfFilled });
    expect(result.status).toBe("created");
    expect(materializeCalls).toHaveLength(0);
  });

  it("is REFUSED on activation, naming WHERE", async () => {
    const result = await create({ draft: false, sentence: halfFilled });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "WHERE" },
    });
  });
});

describe("a DRAFT rule with NO trigger at all", () => {
  // The commonest real draft: the author has written the THEN and not yet the
  // WHEN. It must save (that is the founder's requirement) and must refuse on
  // activation (a rule with no WHEN would never start, so arming it is a lie).
  const noWhen = { ...BASE_SENTENCE, trigger: null };

  it("SAVES", async () => {
    const result = await create({ draft: true, sentence: noWhen });
    expect(result.status).toBe("created");
    expect(materializeCalls).toHaveLength(0);
  });

  it("is REFUSED on activation, naming WHEN", async () => {
    const result = await create({ draft: false, sentence: noWhen });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "WHEN" },
    });
  });
});

describe("draft-ness does not leak into a normal rule", () => {
  it("a complete rule saved WITHOUT draft still compiles and materializes", async () => {
    const result = await create({ sentence: BASE_SENTENCE });
    expect(result.status).toBe("created");
    expect(materializeCalls).toHaveLength(1);
    const metadata = readRuleMetadata(
      (inserted.at(-1)?.metadata ?? {}) as Record<string, unknown>
    );
    // Absent, never a stored `false` — "not a draft" is ONE state whether the
    // rule predates drafts or was never one.
    expect(metadata?.draft).toBeUndefined();
  });

  it("a COMPLETE sentence saved as a draft still materializes nothing", async () => {
    // Draft is the AUTHOR'S declaration that the rule is not ready, not an
    // inference from whether it happens to compile. A door that quietly armed a
    // draft because its sentence looked finished would arm rules nobody
    // activated.
    const result = await create({ draft: true, sentence: BASE_SENTENCE });
    expect(result.status).toBe("created");
    expect(materializeCalls).toHaveLength(0);
  });
});
