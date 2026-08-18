/**
 * PlaybookStage — the ONE runtime WRITE-boundary schema.
 *
 * `PlaybookStage` (@synap/playbooks) was a TypeScript-only fiction: every write
 * door validated `stages` as `z.array(z.record(...))`, an unvalidated bag, and
 * readers defended with inline `as` casts. This is the runtime half — the single
 * place a stage is validated before it lands in the `playbooks.stages` jsonb.
 *
 * It lives HERE, not in @synap/playbooks, on purpose: that package is a
 * dependency-free contract package ("the Hub-REST door + service own
 * validation"), and every consumer of this schema is in @synap/api. The pure
 * half — the `PlaybookStage` type, `PlaybookStageCategory`, the category list,
 * and `resolveStageCategory` (the ONE place a legacy stage's category is
 * defaulted) — stays with the type it describes.
 *
 * Stages are stored as jsonb, so the object schema is LOOSE (`z.looseObject`):
 * unknown keys are preserved, never stripped — a strict object would silently
 * DROP fields on an update round-trip.
 */

import { z } from "zod";
import {
  PLAYBOOK_STAGE_CATEGORIES,
  type PlaybookStageCategory,
} from "@synap/playbooks";

/**
 * The six, as a zod enum. Derived from the contract package's list rather than
 * re-typed, so the door can never drift from the type.
 */
export const playbookStageCategorySchema = z.enum(
  PLAYBOOK_STAGE_CATEGORIES as readonly [
    PlaybookStageCategory,
    ...PlaybookStageCategory[],
  ]
);

/**
 * One stage. `category` is REQUIRED here (the write boundary) while optional on
 * the `PlaybookStage` interface — legacy stored stages have none and must keep
 * reading fine, but nothing new may be written without one.
 */
export const playbookStageSchema = z.looseObject({
  /**
   * Stable identifier; the value that lands on `focus_sessions.currentStage`.
   * Bounded and whitespace-trimmed because it is an id, not prose.
   */
  key: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => v.trim() === v, {
      message: "Stage key must not have leading or trailing whitespace",
    }),
  name: z.string().min(1).max(200),
  category: playbookStageCategorySchema,
  description: z.string().max(5000).optional(),
  goal: z.string().max(5000).optional(),
  grants: z
    .array(
      z.looseObject({
        kind: z.enum(["tool", "skill", "command"]),
        id: z.string().min(1),
      })
    )
    .optional(),
  expectedOutputs: z
    .array(
      z.looseObject({
        kind: z.string().min(1),
        label: z.string().min(1),
        icon: z.string().optional(),
      })
    )
    .optional(),
  suggestedTasks: z.array(z.string()).optional(),
  /** Order WITHIN the category group — never a global order. */
  position: z.number().int().optional(),
  indefinite: z.boolean().optional(),
});

/**
 * A playbook's full ordered stage list. `key` must be UNIQUE within one
 * playbook: `focus_sessions.currentStage` stores a bare key, so a duplicate
 * makes the active stage ambiguous.
 */
export const playbookStagesSchema = z
  .array(playbookStageSchema)
  .superRefine((stages, ctx) => {
    const seen = new Set<string>();
    stages.forEach((stage, index) => {
      if (seen.has(stage.key)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Duplicate stage key "${stage.key}" — stage keys must be unique ` +
            "within a playbook (focus_sessions.currentStage stores the bare key)",
          path: [index, "key"],
        });
      }
      seen.add(stage.key);
    });
  });

export type PlaybookStageInput = z.infer<typeof playbookStageSchema>;
