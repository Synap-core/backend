/**
 * `{{trigger.subject}}` — the ONE origin-independent name for the entity a run
 * is about.
 *
 * WHY IT EXISTS: the four run origins build four different trigger payloads —
 * event (`subjectId`), manual (a flat bag with `entityId` by convention),
 * webhook (`{type,webhookSubscriptionId,body}`) and cron
 * (`{type,expression,scheduledAt}`) — so no expression over `trigger.payload`
 * names the subject for every origin. `automation_runs.subject_entity_id`
 * already holds the answer (derived once by `utils/run-subject.ts`); the
 * executor surfaces it on the context, it is not re-derived.
 *
 * WHY IT HANGS UNDER `trigger` AND NOT A NEW TOP-LEVEL ROOT — and why this file
 * asserts BOTH resolvers: `CONTEXT_ROOT_PATTERN` (`context-path.ts`) is
 * consulted ONLY by `condition-eval.ts` (`resolveOperandList`, and the
 * right-operand branch), NEVER by `resolveTemplate`. A genuinely new root would
 * therefore interpolate correctly in a template and, in a condition, be
 * compared as the LITERAL STRING "subject.id" — silently false, forever. A test
 * that only covered templates would miss exactly that, so every case below is
 * asserted through the template path AND the condition path.
 */
import { describe, it, expect } from "vitest";
import { CONTEXT_ROOT_PATTERN } from "../context-path.js";
import { resolveTemplate } from "../template-resolve.js";
import { evaluateCondition } from "../condition-eval.js";
import type { StepContext } from "../automation-executor-types.js";

const ENTITY = "3f4b1c2e-8a9d-4e1f-9c3a-1d2e3f4a5b6c";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const ctx = (subject: string | null, payload = {}): StepContext => ({
  trigger: { payload, subject },
  steps: {},
  automation: { id: "a1", state: {} },
});

describe("{{trigger.subject}} resolves in BOTH resolvers", () => {
  it("interpolates in a template", () => {
    expect(resolveTemplate("{{trigger.subject}}", ctx(ENTITY))).toBe(ENTITY);
  });

  it("resolves as a LEFT operand in a condition (not compared as a literal)", () => {
    expect(
      evaluateCondition(`trigger.subject === '${ENTITY}'`, ctx(ENTITY))
    ).toBe(true);
    expect(
      evaluateCondition(`trigger.subject === '${ENTITY}'`, ctx(OTHER))
    ).toBe(false);
  });

  it("resolves as a RIGHT operand in a condition", () => {
    const c = ctx(ENTITY, { entityId: ENTITY });
    expect(
      evaluateCondition("trigger.payload.entityId === trigger.subject", c)
    ).toBe(true);
    expect(
      evaluateCondition(
        "trigger.payload.entityId === trigger.subject",
        ctx(OTHER, { entityId: ENTITY })
      )
    ).toBe(false);
  });

  it("resolves in a membership operand list (the third CONTEXT_ROOT_PATTERN site)", () => {
    expect(
      evaluateCondition(
        "trigger.subject in trigger.payload.watchlist",
        ctx(ENTITY, { watchlist: [OTHER, ENTITY] })
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        "trigger.subject in trigger.payload.watchlist",
        ctx(ENTITY, { watchlist: [OTHER] })
      )
    ).toBe(false);
  });

  it("is recognised by CONTEXT_ROOT_PATTERN — the guard condition-eval reads", () => {
    // This is the invariant that makes the two resolvers agree. A top-level
    // root (`subject.id`) would FAIL here while still interpolating in a
    // template: the exact silent split this design avoids.
    expect(CONTEXT_ROOT_PATTERN.test("trigger.subject")).toBe(true);
    expect(CONTEXT_ROOT_PATTERN.test("subject.id")).toBe(false);
  });

  it("renders '' when the run has no subject (cron/webhook/deleted-entity run)", () => {
    expect(resolveTemplate("{{trigger.subject}}", ctx(null))).toBe("");
    expect(evaluateCondition("trigger.subject === ''", ctx(null))).toBe(true);
  });
});

describe("backwards compatibility — the shipped payload paths still work", () => {
  it("{{trigger.payload.subjectId}} is untouched (four relay templates ship it)", () => {
    const c = ctx(ENTITY, {
      subjectId: ENTITY,
      data: { profileSlug: "person" },
    });
    expect(resolveTemplate("{{trigger.payload.subjectId}}", c)).toBe(ENTITY);
    expect(
      evaluateCondition("trigger.payload.data.profileSlug === 'person'", c)
    ).toBe(true);
  });

  it("adding `subject` did not shadow a payload key of the same name", () => {
    const c = ctx(ENTITY, { subject: "a payload field called subject" });
    expect(resolveTemplate("{{trigger.payload.subject}}", c)).toBe(
      "a payload field called subject"
    );
    expect(resolveTemplate("{{trigger.subject}}", c)).toBe(ENTITY);
  });
});
