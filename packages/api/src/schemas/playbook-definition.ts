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

export const playbookDefinitionSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  goalTemplate: z.string().min(1).max(5000),
  params: z.array(jsonRecord).optional(),
  inputStrategy: jsonRecord.optional(),
  channelSpec: jsonRecord.optional(),
  expectedOutputs: z.array(jsonRecord).optional(),
  /**
   * First-class stages — the ONE runtime schema. `category` is required and
   * `key` unique (it is what `focus_sessions.currentStage` stores); a stage may
   * name the `domain` (workspace package slug) it runs in.
   */
  stages: playbookStagesSchema.optional(),
  /** Binary acceptance criteria every instantiated session is graded against. */
  criteria: sessionCriteriaSchema.optional(),
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
