/**
 * PlaybookDefinition — the ONE wire schema for a playbook DEFINITION.
 *
 * WHY THIS EXISTS. Every door that accepts a playbook definition used to
 * re-declare its own `z.object({ name, goalTemplate, ... })`. zod strips
 * undeclared keys, so each door silently dropped whatever it forgot: the Hub
 * `/packages/apply` door (and `market.install`, and the approve executor, which
 * both inherit its parse) dropped `scope`, `stages`, `criteria`,
 * `expectedOutputs` and `metadata`; the browser `createFromDefinition` door
 * dropped `scope`, `stages`, `criteria` and `metadata`; `/capabilities` and
 * `/loops` dropped `scope`. grants.yaml's "Grant Process" (a 6-step PROJECT
 * method) therefore reached every pod as a stageless session template.
 *
 * This object is the definition half of `playbooks.create`'s input
 * (`createInputSchema` in routers/playbooks.ts is `playbookDefinitionSchema`
 * `.extend(...)` with the caller-only fields: attribution, forceCreate,
 * contextSkill, and its `draft` status default). Every package / capability /
 * loop door `.extend`s it with ONLY its door-specific shape (how grants are
 * written, a loop `ref`, a status default) — it never re-declares a field of
 * the definition. `__tripwires__/playbook-definition-one-schema.test.ts`
 * refuses a second `goalTemplate: z.` declaration.
 *
 * `executor` and `status` are optional here on purpose: their DEFAULTS differ
 * by door (the router defaults `draft`, a package install defaults `active` —
 * see marketplace-install.ts), so each door states its own default.
 */

import { z } from "zod";
import { AskSchema } from "@synap-core/types/ask";
import {
  findDroppedParamEntries,
  MAX_REQUIRED_INTENTS,
} from "@synap/playbooks";
import {
  CAPABILITY_INTENTS,
  unknownIntents,
} from "@synap-core/types/capability-intents";
import { playbookStagesSchema } from "./playbook-stage.js";
import { sessionCriteriaSchema } from "./session-criteria.js";
import { playbookScheduleInputSchema } from "./playbook-schedule.js";

export const playbookExecutorSchema = z.enum([
  "is-agent",
  "external-agent",
  "hybrid",
]);
export const playbookStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "archived",
]);
/**
 * `session` = a template of ONE focus session (the default when absent).
 * `project` = a METHOD a project runs as a track; its ordered `stages`
 * coordinate rather than execute. See routers/playbooks.ts (0240).
 */
export const playbookScopeSchema = z.enum(["session", "project"]);

// The richer JSONB shapes (params/inputStrategy/channelSpec/expectedOutputs)
// conform to @synap/playbooks contracts; stored loosely and validated at the
// domain boundary. `stages`, `criteria` and `schedule` are validated by their
// own schemas.
const jsonRecord = z.record(z.string(), z.unknown());

/**
 * One declared slot of a playbook. Stored loosely like its siblings, EXCEPT
 * `ask`: a template's slots are instantiated straight into sessions, so an
 * invalid ask written here would reach every run. It is parsed with the ONE
 * ask schema at the write door — refused here, never silently stored.
 * (`sanitizeDeclaredOutputs` also drops an invalid ask at instantiation, for
 * rows stored before this door checked.)
 */
export const playbookExpectedOutputSchema = z.looseObject({
  ask: AskSchema.nullable().optional(),
});

/**
 * The declared params, as a WRITE door takes them. Each entry stays a loose
 * record (its type/label/options/default are read tolerantly by
 * `readPlaybookParams`), but an entry that reader would DROP is refused here:
 * no `name` (the usual slip is `key`), a duplicate name, or a non-object.
 * Accepting it would tell the caller "saved" about a param no run will ever
 * see. The rule is the reader's own (`findDroppedParamEntries`), never a copy.
 * Issues land on `[index, "name"]` so the propose-time check names the field.
 */
export const playbookParamsInputSchema = z
  .array(jsonRecord)
  .superRefine((entries, ctx) => {
    for (const d of findDroppedParamEntries(entries)) {
      ctx.addIssue({
        code: "custom",
        path: [d.index, "name"],
        message:
          d.reason === "duplicate_name"
            ? `params[${d.index}].name repeats an earlier param's name`
            : d.reason === "not_an_object"
              ? `params[${d.index}] must be an object with a name`
              : d.key
                ? `params[${d.index}] needs "name" (got "key": "${d.key}") — declare it as { "name": "${d.key}", "type": "text" }`
                : `params[${d.index}] needs a "name"`,
      });
    }
  });

/**
 * The ABSTRACT intents a playbook needs the pod to be able to do — the process
 * half of the intent spine (a workspace template's `taskIntents` is what the
 * SPACE needs; a capability template's `provides` is what the PACK serves).
 *
 * Validated against the SAME closed vocabulary `taskIntents` uses, and by the
 * same `unknownIntents` helper — so a playbook requirement and a workspace
 * requirement cannot be spelled from two different lists. The vocabulary is the
 * pod's `capability_intents` TABLE (migrations 0283/0284), mirrored into
 * `@synap-core/types/capability-intents` with a parity guard that re-derives
 * the seed SQL; this file deliberately holds no list of its own.
 *
 * ⚠️ WHAT IS REFUSED HERE IS MEMBERSHIP, NOT SATISFIABILITY. This door never
 * asks whether the pod can currently serve an intent — that is a resolver
 * question, answered by `capability-intent-index` and reported by
 * `matchRequiredIntents`. A playbook MUST be able to declare a requirement
 * nothing installed serves today: that gap is what drives a later install, and
 * gating on it would forbid the specification itself (the `taskIntents`
 * precedent — Content Studio declares 4 intents its one pack covers 1 of, and a
 * subset rule went red on it for exactly that reason).
 *
 * A duplicate is refused too, for the same reason `params` refuses one: the
 * reader would silently drop the second, so telling the author "saved" is a lie
 * about the stored declaration.
 */
export const playbookRequiredIntentsSchema = z
  .array(z.string().min(1))
  .max(MAX_REQUIRED_INTENTS, {
    message: `a playbook declares at most ${MAX_REQUIRED_INTENTS} required intents`,
  })
  .superRefine((intents, ctx) => {
    const seen = new Set<string>();
    for (const [index, intent] of intents.entries()) {
      if (seen.has(intent)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `requiredIntents repeats "${intent}" — it is a set, not a list`,
        });
      }
      seen.add(intent);
    }
    for (const unknown of unknownIntents(intents)) {
      ctx.addIssue({
        code: "custom",
        path: [intents.indexOf(unknown)],
        message:
          `"${unknown}" is not a known intent. The closed vocabulary is: ` +
          `${CAPABILITY_INTENTS.join(", ")}.`,
      });
    }
  });

export const playbookDefinitionSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  goalTemplate: z.string().min(1).max(5000),
  params: playbookParamsInputSchema.optional(),
  inputStrategy: jsonRecord.optional(),
  channelSpec: jsonRecord.optional(),
  expectedOutputs: z.array(playbookExpectedOutputSchema).optional(),
  /**
   * First-class stages — the ONE runtime schema. `category` is required and
   * `key` unique (it is what `focus_sessions.currentStage` stores); a stage may
   * name the `domain` (workspace package slug) it runs in.
   */
  stages: playbookStagesSchema.optional(),
  /** Binary acceptance criteria every instantiated session is graded against. */
  criteria: sessionCriteriaSchema.optional(),
  /** See `playbookRequiredIntentsSchema` — what this process needs the pod to do. */
  requiredIntents: playbookRequiredIntentsSchema.optional(),
  /** `{ profileSlug, filter? }` — the entity kind the playbook operates over. */
  subjectProfile: jsonRecord.optional(),
  /** Validated so `mode` ("run" | "appointment") has a declared writer. Loose; null clears. */
  schedule: playbookScheduleInputSchema.optional(),
  /** Free-form → `playbooks.metadata` (e.g. the propose-only governance marker). */
  metadata: jsonRecord.optional(),
  executor: playbookExecutorSchema.optional(),
  status: playbookStatusSchema.optional(),
  scope: playbookScopeSchema.optional(),
});

/** A parsed playbook definition (output side — defaults applied by the door). */
export type PlaybookDefinition = z.infer<typeof playbookDefinitionSchema>;

/**
 * The PACKAGE form — what a workspace template / pack / Hub `/packages/apply`
 * body carries per playbook. Door-specific shape only:
 *  - `grants` are tool/skill NAMES (the applier resolves them to ids);
 *  - a package install goes LIVE: status defaults `active` (the router's
 *    default is `draft` — see the parse note in marketplace-install.ts);
 *  - executor defaults `is-agent`, as the router does.
 * Also what the boot reconcile parses a template element through, so the
 * reconcile's `desired` is normalized exactly as the install's baseline was.
 */
export const packagePlaybookDefinitionSchema = playbookDefinitionSchema.extend({
  grants: z.array(z.string()).optional(),
  status: playbookStatusSchema.default("active"),
  executor: playbookExecutorSchema.default("is-agent"),
});

export type PackagePlaybookDefinition = z.infer<
  typeof packagePlaybookDefinitionSchema
>;
