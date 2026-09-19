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
import {
  CRITERION_CHECK_KINDS,
  MAX_SESSION_CRITERIA,
  type CriterionCheckKind,
} from "@synap/playbooks";

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
    }),
    stageKey: z.string().min(1).max(120).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.check.kind === "capability" && !c.check.capability) {
      ctx.addIssue({
        code: "custom",
        message: "A capability check names the capability verb to run",
        path: ["check", "capability"],
      });
    }
    if (c.check.kind === "evidence" && !c.check.evidenceKey) {
      ctx.addIssue({
        code: "custom",
        message:
          "An evidence check names the evidenceKey the agent posts under",
        path: ["check", "evidenceKey"],
      });
    }
  });

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
