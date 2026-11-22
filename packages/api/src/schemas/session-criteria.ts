/**
 * SessionCriterion — the WRITE-boundary schema for a session's / playbook's /
 * stage's acceptance criteria. The pure half (type, check kinds, tolerant
 * `readCriteria`) lives in @synap/playbooks; this is the strict half every door
 * validates with before a list lands in jsonb.
 *
 * Strict objects (unlike the loose stage object): a criterion is a CONTROL — a
 * misspelled `evidenceKey` that survived validation is a criterion that can
 * never be met.
 */

import { z } from "zod";
import { looksLikeNeedRef, needRefProblem } from "@synap-core/types/needs";
import {
  CRITERION_ABOUT,
  CRITERION_CHECK_KINDS,
  CRITERION_CHECK_MEANINGS,
  MAX_SESSION_CRITERIA,
  type CriterionAbout,
  type CriterionCheckKind,
  type CriterionCheckMeaning,
} from "@synap/playbooks";
import { checkCriterionMeaning } from "@synap-core/types/units";
import { DECLARED_SLOT_KEY_RE } from "../services/focus-sessions/slot-keys.js";
import {
  MEASURE_CHECK_VERB,
  measureSpecSchema,
} from "../services/capabilities/measure-check.js";

/** The longest a criterion's `check.params` may be, as JSON. */
const CHECK_PARAMS_MAX_CHARS = 2000;

export const sessionCriterionSchema = z
  .strictObject({
    key: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9_.-]*$/, {
        message: "Criterion key must be a lowercase slug",
      }),
    statement: z.string().trim().min(1).max(500),
    required: z.boolean().optional(),
    check: z.strictObject({
      kind: z.enum(
        CRITERION_CHECK_KINDS as readonly [
          CriterionCheckKind,
          ...CriterionCheckKind[],
        ]
      ),
      capability: z.string().min(1).max(200).optional(),
      evidenceKey: z.string().min(1).max(80).optional(),
      hint: z.string().max(1000).optional(),
      /**
       * kind=capability: the verb's arguments (P8). For `measure.check`:
       * `{ op, params, threshold, comparator }`, checked below.
       */
      params: z
        .record(z.string().max(80), z.unknown())
        .refine((p) => Object.keys(p).length <= 20, {
          message: "check.params holds at most 20 keys",
        })
        .refine((p) => JSON.stringify(p).length <= CHECK_PARAMS_MAX_CHARS, {
          message: `check.params is at most ${CHECK_PARAMS_MAX_CHARS} characters of JSON`,
        })
        .optional(),
    }),
    stageKey: z.string().min(1).max(120).optional(),
    /** R5 — what kind of check this is, in people's words. */
    checkKind: z
      .enum(
        CRITERION_CHECK_MEANINGS as readonly [
          CriterionCheckMeaning,
          ...CriterionCheckMeaning[],
        ]
      )
      .optional(),
    /** R7 — about the result (default) or the method. */
    about: z
      .enum(CRITERION_ABOUT as readonly [CriterionAbout, ...CriterionAbout[]])
      .optional(),
    /**
     * The key of the session output this criterion checks: THE pairing of a
     * criterion with an output (`criteriaByOutput`, `@synap-core/types/units`;
     * work-model W1, W4). The same alphabet as a declared slot key.
     */
    outputKey: z
      .string()
      .regex(DECLARED_SLOT_KEY_RE, {
        message:
          "outputKey must be an output key (a lowercase slug: a-z, 0-9, -)",
      })
      .optional(),
  })
  .superRefine((c, ctx) => {
    // R5: the declared meaning must fit the check that carries it.
    const incoherent = checkCriterionMeaning(c);
    if (incoherent) {
      ctx.addIssue({
        code: "custom",
        message: incoherent,
        path: ["checkKind"],
      });
    }
    // A criterion about HOW the work is done checks no output (W4).
    if (c.about === "method" && c.outputKey) {
      ctx.addIssue({
        code: "custom",
        message:
          'A criterion about the method names no output: drop outputKey or set about to "result"',
        path: ["outputKey"],
      });
    }
    if (c.check.kind === "capability" && !c.check.capability) {
      ctx.addIssue({
        code: "custom",
        message: "A capability check names the capability verb to run",
        path: ["check", "capability"],
      });
    }
    // Arguments belong to a verb: only a capability check runs one.
    if (c.check.params && c.check.kind !== "capability") {
      ctx.addIssue({
        code: "custom",
        message: "check.params goes with a capability check only",
        path: ["check", "params"],
      });
    }
    // A measure is checked here, at the write: a misspelled op or param would
    // be a criterion that measures something else, or nothing.
    if (c.check.capability === MEASURE_CHECK_VERB) {
      const measure = measureSpecSchema.safeParse(c.check.params ?? {});
      if (!measure.success) {
        for (const issue of measure.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: `measure.check: ${issue.message}`,
            path: ["check", "params", ...issue.path.map(String)],
          });
        }
      }
    }
    // A need ref (0426) instead of a verb: it must name a need of the
    // vocabulary (and, with a suffix, one of its intents).
    if (c.check.capability && looksLikeNeedRef(c.check.capability)) {
      const problem = needRefProblem(c.check.capability);
      if (problem) {
        ctx.addIssue({
          code: "custom",
          message: problem,
          path: ["check", "capability"],
        });
      }
    }
  })
  // An evidence check with no evidenceKey is posted under the criterion's own
  // key: stored filled, so every reader reads one key.
  .transform((c) =>
    c.check.kind === "evidence" && !c.check.evidenceKey
      ? { ...c, check: { ...c.check, evidenceKey: c.key } }
      : c
  );

/** A criteria list: at most `MAX_SESSION_CRITERIA`, keys unique. */
export const sessionCriteriaSchema = z
  .array(sessionCriterionSchema)
  .max(MAX_SESSION_CRITERIA)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((c, index) => {
      if (seen.has(c.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate criterion key "${c.key}" — keys are unique within a session`,
          path: [index, "key"],
        });
      }
      seen.add(c.key);
    });
  });

/**
 * Evidence an agent posts for `evidence`-checked criteria: one entry per
 * `evidenceKey`, a boolean outcome plus an optional one-line detail. Keys are
 * matched against the session's criteria; an unmatched key grades nothing.
 */
export const sessionEvidenceSchema = z.record(
  z.string().min(1).max(80),
  z.strictObject({
    passed: z.boolean(),
    detail: z.string().max(2000).optional(),
  })
);
