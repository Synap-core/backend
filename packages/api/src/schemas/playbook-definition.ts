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
 * `.extend(...)` with the caller-only fields: attribution,
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
import { validateGuidanceList } from "@synap-core/types/guidance";
import {
  findDroppedParamEntries,
  isRunToolName,
  MAX_REQUIRED_INTENTS,
  OUTPUT_LANDING_EXAMPLES_MAX,
  PLAYBOOK_TOOL_MAX_CHARS,
  PLAYBOOK_TOOLS_MAX,
  readToolsList,
  stageToolsOutsidePlaybook,
} from "@synap/playbooks";
import {
  CAPABILITY_INTENTS,
  isKnownIntent,
  unknownIntents,
} from "@synap-core/types/capability-intents";
import {
  playbookStagesSchema,
  relationTypeSlugSchema,
} from "./playbook-stage.js";
import {
  humanOnlyStatusesSchema,
  playbookActivatorsSchema,
  playbookSubjectProfileSchema,
} from "./playbook-process.js";
import { sessionCriteriaSchema } from "./session-criteria.js";
import {
  playbookRunnerSchema,
  requiresSchema,
  runnerNamesAgentId,
} from "./playbook-runner.js";
import { playbookScheduleInputSchema } from "./playbook-schedule.js";

export const playbookExecutorSchema = z.enum([
  "is-agent",
  "external-agent",
  "hybrid",
  "generate",
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

/** `ExpectedOutput.lands` (@synap/playbooks `OutputLanding`). */
export const outputLandingSchema = z.strictObject({
  target: z.literal("subject_document_section"),
  section: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/, "a section title is one line"),
  /**
   * Past outcomes read as examples (`OutputLanding.examples`): how many of
   * the person's last approved and rejected drafts of this playbook in this
   * space. Off when absent; each count capped so the examples never crowd out
   * the subject in the one call's input bound.
   */
  examples: z
    .strictObject({
      approved: z
        .number()
        .int()
        .min(0)
        .max(OUTPUT_LANDING_EXAMPLES_MAX)
        .optional(),
      rejected: z
        .number()
        .int()
        .min(0)
        .max(OUTPUT_LANDING_EXAMPLES_MAX)
        .optional(),
    })
    .optional(),
});

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
  /**
   * The relation type written output → subject when the slot is satisfied —
   * see `ExpectedOutput.relationToSubject`. Slug-shaped, the SAME schema the
   * stage-level slot uses.
   */
  relationToSubject: relationTypeSlugSchema.optional(),
  /** See `ExpectedOutput.optional` — produced if it applies, never owed. */
  optional: z.boolean().optional(),
  /**
   * Where a one-shot (`executor: "generate"`) playbook's result lands — see
   * `ExpectedOutput.lands`. Strict: an unknown target or key is refused here,
   * never stored and ignored by the run.
   */
  lands: outputLandingSchema.optional(),
});

/**
 * `metadata` — the owner's free-form bag, with ONE conventional key typed:
 * `lineage` (where the process comes from — an APQC PCF id, a named method,
 * O*NET task ids). Convention only: nothing branches on it.
 */
export const playbookMetadataSchema = z.looseObject({
  lineage: z
    .looseObject({
      apqc: z.string().max(200).optional(),
      method: z.string().max(500).optional(),
      onet: z.array(z.string().max(100)).max(50).optional(),
    })
    .optional(),
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
 * The ONE list of what a run of a playbook may use beyond its class floor
 * (plan 08e4fba7, decisions 3 and 4): run tools, intent slugs, capabilities,
 * by name (`@synap/playbooks` `run-tools.ts` says how each entry is read).
 * "Only these". A stage's list must be a subset (`foldPlaybookTools`).
 *
 * An entry nothing on this pod serves is a FACT, never a rejection: a
 * playbook may declare a capability a later install provides (the run is told
 * what is missing). A duplicate is refused: the reader would drop it, so
 * "saved" would misreport the stored list.
 */
export const playbookToolsSchema = z
  .array(z.string().trim().min(1).max(PLAYBOOK_TOOL_MAX_CHARS))
  .max(PLAYBOOK_TOOLS_MAX, {
    message: `a playbook lists at most ${PLAYBOOK_TOOLS_MAX} tools`,
  })
  .superRefine((tools, ctx) => {
    const seen = new Set<string>();
    for (const [index, tool] of tools.entries()) {
      if (seen.has(tool)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `tools repeats "${tool}": it is a set, not a list`,
        });
      }
      seen.add(tool);
    }
  });

/**
 * DEPRECATED INPUT, folded into `tools` at the write door and never stored
 * (`foldPlaybookTools`): the intents a playbook needed (0291). Still accepted
 * so a catalog package or a pending proposal written before 0419 installs
 * whole; still held to the closed intent vocabulary. Remove once no catalog
 * version still sends it (app-bases moved to `tools` in the same wave).
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

/**
 * The rules a playbook follows (design b199a3a4): an ordered list of refs by
 * kind or skill slug, never ids — `{ ref: "kind:brand-voice-guide", label?,
 * when?, where? }`. The grammar is the ONE pure validator's
 * (`@synap-core/types/guidance`; the catalog validator is to call the same
 * one), so a playbook and a manifest cannot accept different refs. An invalid
 * item is refused here with its index, never stored: loose objects, so a key
 * the validator does not know (an `id`) is refused by it, not silently
 * stripped. The update door applies the same schema.
 */
export const playbookGuidanceSchema = z
  .array(
    z.looseObject({
      ref: z.string(),
      label: z.string().optional(),
      when: z.string().optional(),
      where: z.record(z.string(), z.array(z.string())).optional(),
    })
  )
  .superRefine((items, ctx) => {
    for (const issue of validateGuidanceList(items)) {
      ctx.addIssue({
        code: "custom",
        path: issue.index >= 0 ? [issue.index] : [],
        message: issue.message,
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
  /** See `playbookToolsSchema`: what a run of it may use, "only these". */
  tools: playbookToolsSchema.optional(),
  /** DEPRECATED input, folded into `tools` (`foldPlaybookTools`). */
  requiredIntents: playbookRequiredIntentsSchema.optional(),
  /** See `playbookGuidanceSchema` — the rules this process follows, by ref. */
  guidance: playbookGuidanceSchema.optional(),
  /**
   * `{ profileSlug, filter?, statusProperty? }` — the entity kind the playbook
   * operates over, and the property holding its lifecycle. STORES the folded
   * `activators` / `humanOnlyStatuses` too (schemas/playbook-process.ts).
   */
  subjectProfile: playbookSubjectProfileSchema.optional(),
  /**
   * When the process starts — DECLARATIONS compiled into governed rules at
   * install/create (services/playbooks/playbook-activators.ts). Folded into
   * `subjectProfile` for storage by `foldProcessIntoSubjectProfile`.
   */
  activators: playbookActivatorsSchema.optional(),
  /**
   * Subject status values NO stage covers on purpose (e.g. Idea, Archived) —
   * a person sets them, the process neither writes nor follows them. Should a
   * stage still map to one, the advance's subject write always files a
   * proposal, whoever drove it. Folded into `subjectProfile` like `activators`.
   */
  humanOnlyStatuses: humanOnlyStatusesSchema.optional(),
  /** Validated so `mode` ("run" | "appointment") has a declared writer. Loose; null clears. */
  schedule: playbookScheduleInputSchema.optional(),
  /** Free-form → `playbooks.metadata` (e.g. the propose-only governance marker, `lineage`). */
  metadata: playbookMetadataSchema.optional(),
  executor: playbookExecutorSchema.optional(),
  status: playbookStatusSchema.optional(),
  scope: playbookScopeSchema.optional(),
  /**
   * WHO runs this playbook by default — see `PlaybookRunner`
   * (`schemas/playbook-runner.ts`). A choice made at Run beats it; it beats
   * the person's remembered choice (founder via lead, 9 Nov 2026). `null`
   * clears it. Absent ⇒ nobody named, as before.
   */
  runner: playbookRunnerSchema.nullable().optional(),
  /** The tools every step of it needs, by capability key — see `PlaybookStage.requires`. */
  requires: requiresSchema.optional(),
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
const PACKAGE_AGENT_ID_MESSAGE =
  "A package cannot name one agent by id (it names an agent on one pod): use { role } or { engine } instead.";

export const packagePlaybookDefinitionSchema = playbookDefinitionSchema
  .extend({
    grants: z.array(z.string()).optional(),
    status: playbookStatusSchema.default("active"),
    executor: playbookExecutorSchema.default("is-agent"),
  })
  .superRefine((def, ctx) => {
    // A package travels to other pods: an agent id or a playbook id names
    // something on THIS pod only. A role or an engine is portable; a step
    // that is a playbook is not carried by a package yet.
    if (runnerNamesAgentId(def.runner)) {
      ctx.addIssue({
        code: "custom",
        path: ["runner"],
        message: PACKAGE_AGENT_ID_MESSAGE,
      });
    }
    (def.stages ?? []).forEach((stage, index) => {
      if (runnerNamesAgentId(stage.runner)) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", index, "runner"],
          message: PACKAGE_AGENT_ID_MESSAGE,
        });
      }
      if (stage.uses !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["stages", index, "uses"],
          message:
            "A package cannot carry a step that is a playbook yet: `uses` names a playbook on this pod. Create the playbook on the pod instead.",
        });
      }
    });
  });

export type PackagePlaybookDefinition = z.infer<
  typeof packagePlaybookDefinitionSchema
>;

/** A stage whose `tools` name an entry its playbook's `tools` does not list. */
export interface StageToolsOutside {
  stageKey: string;
  outside: string[];
}

/**
 * THE ONE FOLD of a playbook's tool declarations, at every write door
 * (`playbooks.create` / `.update`, which the package, MCP, Hub and approval
 * doors all go through). Mutates nothing; returns the stored shape:
 *   - `tools` = the declared `tools`, then the deprecated `requiredIntents`,
 *     then a package's `grants` names, then every stage's deprecated `grants`
 *     ids, each once; `undefined` when the input declares none of them (an
 *     update that leaves the list alone);
 *   - `stages` with each stage's deprecated `grants` folded into its `tools`
 *     and the key removed;
 *   - `outside`: each stage whose `tools` name an entry the playbook's list
 *     (`tools`, or `currentTools` when the input does not set it) does not
 *     list. The caller refuses the write when it is not empty.
 */
export function foldPlaybookTools(
  input: {
    tools?: readonly string[] | undefined;
    requiredIntents?: readonly string[] | undefined;
    grants?: readonly string[] | undefined;
    stages?: ReadonlyArray<Record<string, unknown>> | undefined;
  },
  currentTools?: readonly string[] | null
): {
  tools: string[] | undefined;
  stages: Array<Record<string, unknown>> | undefined;
  outside: StageToolsOutside[];
} {
  const stageGrantIds = (stage: Record<string, unknown>): string[] =>
    Array.isArray(stage.grants)
      ? stage.grants.flatMap((g) =>
          g &&
          typeof g === "object" &&
          typeof (g as { id?: unknown }).id === "string"
            ? [(g as { id: string }).id]
            : []
        )
      : [];
  const legacyStageIds = (input.stages ?? []).flatMap(stageGrantIds);
  const declares =
    input.tools !== undefined ||
    input.requiredIntents !== undefined ||
    (input.grants?.length ?? 0) > 0 ||
    legacyStageIds.length > 0;
  const tools = declares
    ? readToolsList([
        ...(input.tools ?? []),
        ...(input.requiredIntents ?? []),
        ...(input.grants ?? []),
        ...legacyStageIds,
      ])
    : undefined;
  const stages = input.stages?.map((stage) => {
    if (!("grants" in stage)) return { ...stage };
    const { grants: _grants, ...rest } = stage;
    const folded = readToolsList([
      ...(Array.isArray(rest.tools) ? rest.tools : []),
      ...stageGrantIds(stage),
    ]);
    return folded.length > 0 ? { ...rest, tools: folded } : rest;
  });
  const playbookTools = tools ?? readToolsList(currentTools ?? []);
  const outside: StageToolsOutside[] = [];
  for (const stage of stages ?? []) {
    const outsideOf = stageToolsOutsidePlaybook(
      playbookTools,
      readToolsList(stage.tools)
    );
    if (outsideOf.length > 0) {
      outside.push({ stageKey: String(stage.key), outside: outsideOf });
    }
  }
  return { tools, stages, outside };
}

/** The refusal sentence for {@link foldPlaybookTools}' `outside`. */
export function describeStageToolsOutside(
  outside: readonly StageToolsOutside[]
): string {
  return (
    outside
      .map(
        (o) =>
          `Stage "${o.stageKey}" lists ${o.outside.map((t) => `"${t}"`).join(", ")}, which the playbook's tools do not list.`
      )
      .join(" ") +
    " A stage narrows its playbook's tools, never widens them: add them to the playbook's `tools` or remove them from the stage. Nothing was saved."
  );
}

/**
 * The entries of a `tools` list that name a capability (neither a run tool
 * nor an intent slug). A package install derives the playbook's governance
 * `grants` links from them (a follow's grant widening reads those links), so
 * a catalog playbook declares its capabilities ONCE, in `tools`.
 */
export function capabilityEntriesOf(
  tools: readonly string[] | undefined
): string[] {
  return readToolsList(tools ?? []).filter(
    (t) => !isRunToolName(t) && !isKnownIntent(t)
  );
}
