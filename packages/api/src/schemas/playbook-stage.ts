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
  STAGE_GATE_PROPOSAL_TYPES,
  MAX_STAGE_LESSONS,
  STAGE_LESSON_MAX_CHARS,
  type PlaybookStage,
  type PlaybookStageCategory,
  type StageGateProposalType,
} from "@synap/playbooks";
import type { TrackStageDeclaration } from "@synap-core/types/units";
import { sessionCriteriaSchema } from "./session-criteria.js";

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

const STAGE_DOMAIN_MESSAGE =
  'Stage domain must be a workspace template slug (lowercase, e.g. "crm"), not a workspace id or name';

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
  /**
   * Entry gate (optional; absent ⇒ the stage advances freely).
   *
   * STRICT, unlike its siblings: the surrounding stage object is loose because
   * dropping an unknown stage field on a round-trip would lose data, but a gate
   * is a CONTROL. A misspelled key inside a control that silently survives
   * validation is how "the stage looked gated and wasn't" happens — so an
   * unknown key here is a parse error, not a preserved passenger.
   */
  gate: z
    .strictObject({
      // "check" evaluates the criteria of the stage being LEFT before the run
      // may continue (services/playbooks/stage-gate.ts).
      kind: z.enum(["human", "check"]),
      // Closed set, derived from the contract package — see the comment on
      // `PlaybookStageGate.proposalType` for why a free string here would file
      // gates that approve without ever resuming the run.
      proposalType: z
        .enum(
          STAGE_GATE_PROPOSAL_TYPES as readonly [
            StageGateProposalType,
            ...StageGateProposalType[],
          ]
        )
        .optional(),
    })
    .optional(),
  /** Binary acceptance criteria belonging to this stage (stageKey stamped at instantiate). */
  criteria: sessionCriteriaSchema.optional(),
  /** What earlier runs of this stage taught — see `PlaybookStage.lessons`. */
  lessons: z
    .array(z.string().trim().min(1).max(STAGE_LESSON_MAX_CHARS))
    .max(MAX_STAGE_LESSONS)
    .optional(),
  /**
   * The DOMAIN this stage is worked in — a workspace TEMPLATE slug
   * (`workspaces.package_slug`), see `PlaybookStage.domain`. Slug-shaped so a
   * workspace id or a display name is refused at the door rather than stored
   * as a domain no workspace will ever carry.
   */
  domain: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^@?[a-z0-9][a-z0-9._/-]*$/, { message: STAGE_DOMAIN_MESSAGE })
    .refine(
      (v) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          v
        ),
      { message: STAGE_DOMAIN_MESSAGE }
    )
    .optional(),
});

// ── Compile-time coverage floor: every stage field is CLASSIFIED ─────────────
//
// A track reads its pinned stages through ONE whitelist, `readStage`
// (@synap-core/types/units track.ts). A field added here (the write door) or on
// `PlaybookStage` (the type) but not there is stored, pinned into every track
// snapshot — and silently invisible to every track reader. That is how
// `stage.domain` would have been lost (W2a). So every key of BOTH the type and
// this schema must be classified: READ by the track (and therefore declared on
// `TrackStageDeclaration`) or WITHHELD with a reason. A new unclassified key
// makes `_stageFieldsClassified` `never` and the build stops here.
//
// What this does NOT prove: that `readStage` actually ASSIGNS a READ field —
// only that its output type declares it. `track.test.ts` covers the values.

/** Stage fields the track read (`readStage`) projects. */
const _TRACK_READ_STAGE_FIELDS = [
  "key",
  "name",
  "category",
  "description",
  "goal",
  "expectedOutputs",
  "suggestedTasks",
  "criteria",
  "gate",
  "indefinite",
  "domain",
] as const satisfies ReadonlyArray<
  keyof PlaybookStage & keyof TrackStageDeclaration
>;

/** Stage fields a track never reads — each with its reason. */
const _TRACK_WITHHELD_STAGE_FIELDS = [
  // Capability grants apply to a session RUN of the playbook (session tools);
  // a track stage session is started without a template binding.
  "grants",
  // Order within a category group — the snapshot's array order is the track's.
  "position",
  // Agent guidance revised by the lessons scanner on the LIVE playbook; a
  // pinned copy would go stale.
  "lessons",
] as const satisfies ReadonlyArray<keyof PlaybookStage>;

type ClassifiedStageField =
  | (typeof _TRACK_READ_STAGE_FIELDS)[number]
  | (typeof _TRACK_WITHHELD_STAGE_FIELDS)[number];
type _StageFieldsClassified =
  Exclude<
    keyof PlaybookStage | keyof typeof playbookStageSchema.shape,
    ClassifiedStageField
  > extends never
    ? true
    : never;
const _stageFieldsClassified: _StageFieldsClassified = true;
void _stageFieldsClassified;

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
