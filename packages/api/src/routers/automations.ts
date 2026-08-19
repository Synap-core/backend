/**
 * Automations Router
 *
 * CRUD for workflow automations + run history.
 * Automations are created as drafts (typically by AI), then activated by the user.
 */

import { z } from "zod";
import { createLogger } from "@synap-core/core";
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { normalizeEventSource } from "../lib/event-helpers.js";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
// Import from events/unified sub-path because tsup's code-splitting drops
// validateEventPattern from the main index.js and events/index.js bundles.
// The same sub-path is the SSOT for the emittable-event grammar (SUBJECT_TYPES
// × EVENT_ACTIONS) + the connector / message-alias / observation families that
// `validateEventPattern` accepts — the honest-menu "catalog" tier derives from
// these constants rather than a hand-invented list.
import {
  validateEventPattern,
  SUBJECT_TYPES,
  EVENT_ACTIONS,
  CONNECTOR_SUBJECT_TYPES,
  MESSAGE_ALIAS_PATTERNS,
  OBSERVATION_NAMESPACES,
} from "@synap-core/types/events/unified";
// Vocabulary door — the ONE place machine tokens become human words. Trigger
// events use PAST mood ("A task was created"); actions use IMPERATIVE mood
// ("Create an entity"). Never a hand-written label map (see .claude/rules/vocabulary.md).
import {
  resolveActionLabel,
  resolveObjectNoun,
  humanizeToken,
} from "@synap-core/types/vocabulary";
import { validateTriggerFilters } from "@synap-core/types/automations/filter-operators";
import {
  flowValidationErrorMessage,
  type FlowValidationResolvers,
} from "../services/automations/validate-flow.js";
import { visibleSkillsWhere } from "../services/skills/visibility.js";
import {
  getDb,
  eq,
  ne,
  and,
  or,
  isNull,
  inArray,
  gt,
  lt,
  asc,
  desc,
  count,
  drizzleSql,
  automations,
  automationRuns,
  automationStepRuns,
  channels,
  playbooks,
  skills,
  events,
  links,
  ChannelRepository,
} from "@synap/database";
import type {
  AutomationTriggerConfig,
  FlowDefinition,
  OutputNodeDef,
} from "@synap/database";
// Shared with the runtime run-narration resolver (post-run-summary.ts): the ONE
// SSOT for `metadata.resultRouting`. Imported (not re-copied) — the static
// feedTargets resolver must classify routing identically to `resolveRunChannel`.
import {
  resolveResultRouting,
  selectRunChannelBranch,
} from "@synap/jobs/utils/post-run-summary.js";
import { subjectEntityIdFromPayload } from "@synap/jobs/utils/run-subject.js";
import { TRPCError } from "@trpc/server";
import {
  decodeDefinitionCursor,
  encodeDefinitionCursor,
} from "../utils/keyset-cursor.js";

const logger = createLogger({ module: "automations-router" });

const automationDataContractItemBase = {
  id: z.string().min(1),
  label: z.string().min(1).max(200),
  nodeIds: z.array(z.string().min(1)).min(1),
};

/**
 * The ONE definition of the "Gets data / Stores in Synap / Reacts & sends"
 * contract every AI-authored automation must carry on `metadata.dataContract`.
 * Exported so the MCP tool surface can DERIVE its published JSON Schema from it
 * (`routers/mcp/tools/index.ts`) instead of hand-copying a second shape that
 * would silently drift from the gate that rejects it.
 */
export const automationDataContractSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["ingest", "react", "ingest_and_react"]),
    gets: z
      .array(
        z.object({
          ...automationDataContractItemBase,
          origin: z.enum(["external", "synap", "schedule", "manual"]),
          event: z.string().min(1).max(300),
          provider: z.string().min(1).max(100).optional(),
        })
      )
      .min(1),
    stores: z.array(
      z.object({
        ...automationDataContractItemBase,
        resource: z.string().min(1).max(200),
      })
    ),
    reacts: z.array(
      z.object({
        ...automationDataContractItemBase,
        kind: z.enum([
          "synap_write",
          "external_write",
          "notification",
          "agent",
          "process",
        ]),
        destination: z.string().min(1).max(200).optional(),
      })
    ),
  })
  .superRefine((value, context) => {
    const sectionsMatchMode =
      (value.mode === "ingest" &&
        value.stores.length > 0 &&
        value.reacts.length === 0) ||
      (value.mode === "react" &&
        value.stores.length === 0 &&
        value.reacts.length > 0) ||
      (value.mode === "ingest_and_react" &&
        value.stores.length > 0 &&
        value.reacts.length > 0);
    if (!sectionsMatchMode) {
      context.addIssue({
        code: "custom",
        message:
          "Data contract mode must match its Stores in Synap and Reacts & sends sections.",
        path: ["mode"],
      });
    }
  });

/**
 * Flatten a contract parse failure into one actionable sentence.
 *
 * The mode↔sections rule lives in a `.superRefine`, which JSON Schema cannot
 * express — so the schema the MCP tool publishes accepts payloads this parse
 * rejects. That is tolerable ONLY if the rejection says which rule was broken;
 * otherwise the agent is told it omitted the thing it provided.
 */
function describeContractIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    const where = issue.path.length > 0 ? issue.path.join(".") : "contract";
    const line = `${where}: ${issue.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
    if (parts.length === 4) break; // enough to act on; not a wall of text
  }
  return parts.join("; ");
}

function validateAiAutomationDataContract(
  input: {
    agentUserId?: string;
    source?: "user" | "ai" | "intelligence" | "system" | "agent";
    metadata?: Record<string, unknown>;
    flowDefinition: { nodes: Array<Record<string, unknown>> };
  },
  context: z.RefinementCtx
): void {
  const isAiAuthored =
    input.agentUserId != null ||
    input.source === "ai" ||
    input.source === "agent";
  if (!isAiAuthored) return;

  const parsed = automationDataContractSchema.safeParse(
    input.metadata?.dataContract
  );
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      path: ["metadata", "dataContract"],
      // ABSENT and INVALID are different failures and must read differently.
      // Saying "requires an explicit contract" to an agent that SENT one — it
      // merely tripped the mode↔sections rule, which the published JSON Schema
      // cannot express — makes it retry the identical payload forever. Carry the
      // real reasons through.
      message:
        input.metadata?.dataContract === undefined
          ? "AI-authored automations require an explicit Gets data / Stores in Synap / Reacts & sends contract."
          : `The Gets data / Stores in Synap / Reacts & sends contract is invalid: ${describeContractIssues(parsed.error)}`,
    });
    return;
  }

  for (const issue of findUnknownDataContractNodeReferences(
    parsed.data,
    input.flowDefinition
  )) {
    context.addIssue({
      code: "custom",
      path: [
        "metadata",
        "dataContract",
        issue.section,
        issue.itemIndex,
        "nodeIds",
        issue.nodeIndex,
      ],
      message: `Data contract references unknown flow node "${issue.nodeId}".`,
    });
  }
}

interface UnknownDataContractNodeReference {
  section: "gets" | "stores" | "reacts";
  itemIndex: number;
  nodeIndex: number;
  nodeId: string;
}

function findUnknownDataContractNodeReferences(
  contract: z.infer<typeof automationDataContractSchema>,
  flowDefinition: { nodes: Array<Record<string, unknown>> }
): UnknownDataContractNodeReference[] {
  const flowNodeIds = new Set(
    flowDefinition.nodes.flatMap((node) =>
      typeof node.id === "string" && node.id.length > 0 ? [node.id] : []
    )
  );
  const unknownReferences: UnknownDataContractNodeReference[] = [];
  for (const section of ["gets", "stores", "reacts"] as const) {
    contract[section].forEach((item, itemIndex) => {
      item.nodeIds.forEach((nodeId, nodeIndex) => {
        if (flowNodeIds.has(nodeId)) return;
        unknownReferences.push({
          section,
          itemIndex,
          nodeIndex,
          nodeId,
        });
      });
    });
  }
  return unknownReferences;
}

/**
 * Resolve `skillName` → `skillId` on `skill` flow nodes that carry a name but no
 * id (the template-friendly authoring form: a capability seeds a skill + an
 * automation that references it by its stable name, since the runtime id isn't
 * known at author time — mirrors `playbook_run`'s id-OR-name). Mutates the flow
 * in place BEFORE it is persisted (and before it is carried into an AI proposal),
 * so the runtime always sees a concrete `skillId`. It uses the runtime's active
 * skill visibility predicate. Unresolved names are left as-is; the validation
 * resolver rejects them before either persistence door reaches this helper.
 */
async function injectSkillIdsFromNames(
  database: Awaited<ReturnType<typeof getDb>>,
  flow: { nodes: Array<Record<string, unknown>>; edges: unknown[] },
  workspaceId: string | null | undefined,
  userId: string
): Promise<void> {
  for (const node of flow.nodes) {
    if (node?.type !== "skill") continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const skillName =
      typeof data.skillName === "string" ? data.skillName.trim() : "";
    const hasId =
      typeof data.skillId === "string" && data.skillId.trim().length > 0;
    if (hasId || !skillName) continue;
    const [match] = await database
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.name, skillName),
          eq(skills.status, "active"),
          visibleSkillsWhere(userId, workspaceId ?? undefined)
        )
      )
      .limit(1);
    if (match) {
      data.skillId = match.id;
      node.data = data;
    }
  }
}

/**
 * Load only the catalog references carried by one submitted flow, then expose
 * them through the pure validator's synchronous resolver contract. This keeps
 * validation at the author door without turning every create/update into an
 * unbounded catalog scan.
 *
 * Skill and capability references use the same active, caller-visible skill
 * predicate as the runtime capability dispatcher. Playbook references follow
 * the runner's workspace-or-pod resolution (an id has priority over a name).
 */
async function loadFlowValidationResolvers(
  database: Awaited<ReturnType<typeof getDb>>,
  flow: { nodes: Array<Record<string, unknown>>; edges: unknown[] },
  workspaceId: string | null | undefined,
  userId: string
): Promise<FlowValidationResolvers> {
  const verbIds = new Set<string>();
  const skillIds = new Set<string>();
  const skillNames = new Set<string>();
  const playbookIds = new Set<string>();
  const playbookNames = new Set<string>();

  for (const node of flow.nodes) {
    if (!node || typeof node !== "object") continue;
    const data = node.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const nodeData = data as Record<string, unknown>;
    const stringValue = (key: string) =>
      typeof nodeData[key] === "string" && nodeData[key].trim().length > 0
        ? (nodeData[key] as string)
        : undefined;

    if (node.type === "capability") {
      const verbId = stringValue("verbId");
      if (verbId) verbIds.add(verbId);
    } else if (node.type === "skill") {
      const skillId = stringValue("skillId");
      const skillName = stringValue("skillName");
      if (skillId) skillIds.add(skillId);
      else if (skillName) skillNames.add(skillName);
    } else if (node.type === "playbook_run") {
      const playbookId = stringValue("playbookId");
      const playbookName = stringValue("playbookName");
      if (playbookId) playbookIds.add(playbookId);
      else if (playbookName) playbookNames.add(playbookName);
    }
  }

  const skillReferenceNames = [...new Set([...verbIds, ...skillNames])];
  const skillReferenceIds = [...skillIds];
  const playbookReferenceIds = [...playbookIds];
  const playbookReferenceNames = [...playbookNames];

  const skillRows =
    skillReferenceIds.length > 0 || skillReferenceNames.length > 0
      ? await database
          .select({ id: skills.id, name: skills.name })
          .from(skills)
          .where(
            and(
              visibleSkillsWhere(userId, workspaceId ?? undefined),
              eq(skills.status, "active"),
              skillReferenceIds.length > 0 && skillReferenceNames.length > 0
                ? or(
                    inArray(skills.id, skillReferenceIds),
                    inArray(skills.name, skillReferenceNames)
                  )
                : skillReferenceIds.length > 0
                  ? inArray(skills.id, skillReferenceIds)
                  : inArray(skills.name, skillReferenceNames)
            )
          )
      : [];

  const playbookRows =
    playbookReferenceIds.length > 0 || playbookReferenceNames.length > 0
      ? await database
          .select({ id: playbooks.id, name: playbooks.name })
          .from(playbooks)
          .where(
            and(
              workspaceId
                ? or(
                    eq(playbooks.workspaceId, workspaceId),
                    isNull(playbooks.workspaceId)
                  )
                : isNull(playbooks.workspaceId),
              playbookReferenceIds.length > 0 &&
                playbookReferenceNames.length > 0
                ? or(
                    inArray(playbooks.id, playbookReferenceIds),
                    inArray(playbooks.name, playbookReferenceNames)
                  )
                : playbookReferenceIds.length > 0
                  ? inArray(playbooks.id, playbookReferenceIds)
                  : inArray(playbooks.name, playbookReferenceNames)
            )
          )
      : [];

  const foundSkillIds = new Set(skillRows.map((skill) => skill.id));
  const foundSkillNames = new Set(skillRows.map((skill) => skill.name));
  const foundPlaybookIds = new Set(playbookRows.map((playbook) => playbook.id));
  const foundPlaybookNames = new Set(
    playbookRows.map((playbook) => playbook.name)
  );

  return {
    verbExists: (verbId) => foundSkillNames.has(verbId),
    skillExists: ({ skillId, skillName }) =>
      skillId
        ? foundSkillIds.has(skillId)
        : !!skillName && foundSkillNames.has(skillName),
    playbookExists: ({ playbookId, playbookName }) =>
      playbookId
        ? foundPlaybookIds.has(playbookId)
        : !!playbookName && foundPlaybookNames.has(playbookName),
  };
}

/**
 * Compute next cron run time by forward-scanning from a base date.
 * Supports standard 5-field cron (minute hour dayOfMonth month dayOfWeek).
 */
function computeNextCronRunAt(cronExpr: string, fromDate: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;
  const dayNames: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  };

  function matches(field: string, value: number): boolean {
    if (field === "*") return true;
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    for (const v of field.split(",")) {
      if (v.includes("-")) {
        const [s, e] = v.split("-").map(Number);
        if (value >= s && value <= e) return true;
        continue;
      }
      const resolved = dayNames[v.toUpperCase()] ?? parseInt(v, 10);
      if (resolved === value) return true;
    }
    return false;
  }

  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      matches(minExpr, candidate.getMinutes()) &&
      matches(hourExpr, candidate.getHours()) &&
      matches(domExpr, candidate.getDate()) &&
      matches(monthExpr, candidate.getMonth() + 1) &&
      matches(dowExpr, candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/**
 * One-line human summary of an entity-create trigger for a UI card. When the
 * trigger carries a `filters.profileSlug` it names that profile; an absent
 * filter means the automation fires on ANY entity creation.
 */
function summarizeEntityCreateTrigger(config: AutomationTriggerConfig): string {
  const slug = config.filters?.profileSlug as string | undefined;
  return slug ? `On ${slug} created` : "On any entity created";
}

type AutomationDatabase = Awaited<ReturnType<typeof getDb>>;

interface AutomationMaterializationInput {
  workspaceId?: string | null;
  name: string;
  description?: string;
  triggerType: "event" | "cron" | "webhook" | "manual";
  triggerConfig: Record<string, unknown>;
  flowDefinition: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  status: "draft" | "active" | "paused" | "error";
  metadata?: Record<string, unknown>;
  state?: Record<string, unknown>;
  source?: "user" | "ai" | "intelligence" | "system" | "agent";
}

/**
 * CREATE/UPDATE-DOOR GATE for `triggerConfig.filters`.
 *
 * The runtime evaluator (`@synap/jobs` automation-trigger-matcher `matchFilters`)
 * and this validator share ONE operator vocabulary
 * (`@synap-core/types/automations/filter-operators`), so the door can never
 * accept a filter the matcher cannot evaluate — the exact drift that left every
 * event-automation on the pod permanently unreachable while reporting
 * `status: active`.
 *
 * This gate matters MORE than a normal input check because `automation.create`
 * sits on the pod's auto-approve list: an agent-authored automation materializes
 * with no human review, so there is no second reader to notice a filter that can
 * never match. Every shape rejected here matches zero events under BOTH the old
 * and the new matcher, so it can never reject an automation that works.
 */
function assertValidTriggerFilters(filters: unknown): void {
  const result = validateTriggerFilters(filters);
  if (!result.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: result.error });
  }
}

async function prepareAutomationForMaterialization(
  database: AutomationDatabase,
  input: AutomationMaterializationInput,
  createdBy: string
): Promise<void> {
  if (input.source === "ai" || input.source === "agent") {
    const contract = automationDataContractSchema.safeParse(
      input.metadata?.dataContract
    );
    if (!contract.success) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "AI-authored automations require an explicit Gets data / Stores in Synap / Reacts & sends contract.",
      });
    }
    const unknownReferences = findUnknownDataContractNodeReferences(
      contract.data,
      input.flowDefinition
    );
    if (unknownReferences.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Data contract references unknown flow node "${unknownReferences[0]?.nodeId}".`,
      });
    }
  }

  if (
    input.triggerType === "event" &&
    typeof input.triggerConfig.eventPattern === "string"
  ) {
    try {
      validateEventPattern(input.triggerConfig.eventPattern);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: (error as Error).message,
      });
    }
  }

  if (input.triggerType === "event") {
    assertValidTriggerFilters(input.triggerConfig.filters);
  }

  const resolvers = await loadFlowValidationResolvers(
    database,
    input.flowDefinition,
    input.workspaceId,
    createdBy
  );
  const flowError = flowValidationErrorMessage(input.flowDefinition, resolvers);
  if (flowError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: flowError });
  }

  // Normalize template-friendly skill names before either proposal storage or
  // final materialization, so every persisted flow dispatches by stable id.
  await injectSkillIdsFromNames(
    database,
    input.flowDefinition,
    input.workspaceId,
    createdBy
  );
}

/** Postgres unique-violation SQLSTATE — raised by automations_workspace_name_active_uq. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/**
 * Load the surviving non-archived automation for (workspaceId, name).
 * Case-insensitive on name; NULL workspace = pod-wide (matches the unique index
 * COALESCE sentinel). Newest-wins (updated_at DESC) so concurrent 23505 recovery
 * agrees with 0230's soft-archive keep-most-recently-updated rule.
 */
async function findNonArchivedAutomationByName(
  database: AutomationDatabase,
  workspaceId: string | null | undefined,
  name: string
): Promise<{ id: string } | null> {
  const scope =
    workspaceId == null || workspaceId === ""
      ? isNull(automations.workspaceId)
      : eq(automations.workspaceId, workspaceId);
  const [row] = await database
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        scope,
        drizzleSql`lower(${automations.name}) = lower(${name})`,
        ne(automations.status, "archived")
      )
    )
    .orderBy(desc(automations.updatedAt), desc(automations.id))
    .limit(1);
  return row ?? null;
}

async function insertAutomationAfterGovernance(
  database: AutomationDatabase,
  input: AutomationMaterializationInput,
  createdBy: string,
  stableId?: string,
  /**
   * P2-3 (draft-state remedy): true for every agent-originated create — the
   * auto-approved direct path (`automation.create` ∈ DEFAULT_AUTO_APPROVE)
   * AND the proposal-approved materialize path. `automation.create` stays
   * auto-approved (no proposal friction for the proactive-bridge roadmap),
   * but a planted WHEN-trigger from a prompt-injected agent must not be able
   * to FIRE unreviewed — so an agent-authored automation always lands
   * `draft` regardless of the `status` it requested. A human's OWN direct
   * create (no agentUserId) is never forced — it keeps its requested status.
   */
  forceDraft = false
): Promise<string | null> {
  const status = forceDraft ? "draft" : input.status;
  let nextRunAt: Date | null = null;
  if (status === "active" && input.triggerType === "cron") {
    const expression = input.triggerConfig.expression as string | undefined;
    if (expression) nextRunAt = computeNextCronRunAt(expression, new Date());
  }

  // Insert with 23505 recovery against automations_workspace_name_active_uq
  // (0230). Re-authoring the same automation (MCP create_automation, a capability
  // re-seeding "Enrich the lead" on reconcile) used to clone a 2nd row — the
  // name-unique index makes the loser a unique-violation, and we return the
  // existing winner instead of a 500 or a duplicate (mirrors playbooks.create).
  // onConflictDoNothing({target: id}) still absorbs the stableId re-materialize
  // retry (same primary key); the name index is a DIFFERENT constraint, so a
  // same-name / different-id clone throws 23505 and is caught below.
  try {
    const [row] = await database
      .insert(automations)
      .values({
        ...(stableId ? { id: stableId } : {}),
        workspaceId: input.workspaceId ?? null,
        createdBy,
        name: input.name,
        description: input.description,
        triggerType: input.triggerType,
        triggerConfig: input.triggerConfig,
        flowDefinition: input.flowDefinition as unknown as FlowDefinition,
        status,
        ...(nextRunAt ? { nextRunAt } : {}),
        state: input.state ?? {},
        metadata: {
          ...(input.metadata ?? {}),
          createdVia:
            input.source === "agent" || input.source === "ai"
              ? ("ai" as const)
              : ("manual" as const),
        },
      })
      .onConflictDoNothing({ target: automations.id })
      .returning({ id: automations.id });

    // row is undefined only when onConflictDoNothing swallowed a primary-key
    // conflict (stableId re-materialize) — the row already exists under stableId.
    return row?.id ?? stableId ?? null;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findNonArchivedAutomationByName(
      database,
      input.workspaceId ?? null,
      input.name
    );
    if (!winner) throw err;
    logger.info(
      {
        automationId: winner.id,
        workspaceId: input.workspaceId ?? null,
        name: input.name,
      },
      "automations.create: unique violation — returning existing non-archived automation"
    );
    return winner.id;
  }
}

/**
 * Canonical materialization path for an already-approved AI proposal.
 * It repeats current catalog validation, preserves the agent as runtime
 * principal, and converges retries on the proposal's stable target id.
 */
export async function materializeApprovedAutomation(input: {
  database: AutomationDatabase;
  definition: AutomationMaterializationInput;
  agentUserId: string;
  stableId: string;
}): Promise<string | null> {
  await prepareAutomationForMaterialization(
    input.database,
    input.definition,
    input.agentUserId
  );
  // forceDraft: true — this materializer is EXCLUSIVELY the agent-authored
  // proposal-approval path (see P2-3 note on insertAutomationAfterGovernance).
  return insertAutomationAfterGovernance(
    input.database,
    input.definition,
    input.agentUserId,
    input.stableId,
    true
  );
}

// ============================================================================
// Rules ecosystem — honest WHEN / THEN menus (SLICE 1)
//
// A "rule" reads "WHEN <event> (WHERE <filter>) → THEN <action>". These two
// read-only queries feed the authoring menus. The founder's hard requirement is
// that the WHEN menu shows ONLY genuinely-real events: the union of an
// authoritative catalog, what a source has ACTUALLY emitted (with counts), and
// what a capability DECLARES it produces.
// ============================================================================

/**
 * RuleScope — the lens a rule is authored under. Every field optional: a rule
 * can be pod-wide or narrowed by any combination.
 */
const ruleScopeSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  capabilityId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  entityId: z.string().uuid().optional(),
});
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** PINNED CONTRACT — do NOT rename/reshape (seam-fork has bitten this 4×). */
const eventOptionSchema = z.object({
  pattern: z.string(),
  label: z.string(),
  profileSlug: z.string().optional(),
  source: z.enum(["observed", "declared", "catalog"]),
  observedCount: z.number().int().nonnegative().optional(),
});
export type EventOption = z.infer<typeof eventOptionSchema>;

const actionOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  outputType: z.string(),
  params: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        required: z.boolean(),
      })
    )
    .optional(),
});
export type ActionOption = z.infer<typeof actionOptionSchema>;

/**
 * The automation OUTPUT-node vocabulary — the THEN half of a rule.
 * SSOT: the `OutputNodeDef['data']['outputType']` union in
 * packages/database/src/schema/automations.ts (lines 239-250). That union is a
 * TYPE (erased at runtime), so this array mirrors it; the `satisfies` (array ⊆
 * union) plus the coverage assertion below (union ⊆ array) make tsc FAIL if the
 * two ever drift — it can never silently fall out of sync with the executor
 * switch in packages/jobs/src/workers/steps/output.ts.
 */
const OUTPUT_NODE_TYPES = [
  "notification",
  "entity_create",
  "entity_update",
  "facet_attach",
  "facet_update",
  "facet_detach",
  "relation_create",
  "webhook",
  "channel_message",
  "session_update",
  "set_state",
] as const satisfies readonly OutputNodeDef["data"]["outputType"][];

// Coverage guard: fails to compile if a new outputType is added to the schema
// union but not mirrored above (Record<never, true> === {} is legal; any missing
// member becomes a required key with no value).
const _assertOutputCoverage: Record<
  Exclude<
    OutputNodeDef["data"]["outputType"],
    (typeof OUTPUT_NODE_TYPES)[number]
  >,
  true
> = {};
void _assertOutputCoverage;

/**
 * Structural decomposition of each output type into (verb, objectKind) TOKENS —
 * NOT an English label map. Every English word still comes exclusively from the
 * vocabulary door; this only records which verb/noun token each output node is
 * built from, which is the router's own structural knowledge of its output
 * types. A new output type is caught by the coverage assertion above.
 */
const OUTPUT_ACTION_SHAPES: Record<
  (typeof OUTPUT_NODE_TYPES)[number],
  { verb: string; objectKind: string }
> = {
  entity_create: { verb: "create", objectKind: "entity" },
  entity_update: { verb: "update", objectKind: "entity" },
  facet_attach: { verb: "attach", objectKind: "entity_facet" },
  facet_update: { verb: "update", objectKind: "entity_facet" },
  facet_detach: { verb: "detach", objectKind: "entity_facet" },
  relation_create: { verb: "create", objectKind: "relation" },
  channel_message: { verb: "send", objectKind: "message" },
  notification: { verb: "send", objectKind: "notification" },
  webhook: { verb: "send", objectKind: "webhook" },
  session_update: { verb: "update", objectKind: "focus_session" },
  set_state: { verb: "set", objectKind: "state" },
};

const capitalize = (s: string): string =>
  s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const withArticle = (noun: string): string =>
  `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

/** IMPERATIVE-mood label for a THEN action, via the vocabulary door. */
function actionLabelFor(
  outputType: (typeof OUTPUT_NODE_TYPES)[number]
): string {
  const shape = OUTPUT_ACTION_SHAPES[outputType];
  const verb = resolveActionLabel(shape.verb, "imperative");
  const noun = resolveObjectNoun(shape.objectKind).toLowerCase();
  return `${verb} ${withArticle(noun)}`;
}

/** PAST-mood label for a WHEN trigger event pattern, via the vocabulary door. */
function eventLabelFor(pattern: string, subject: string): string {
  const parts = pattern.split(".");
  const noun = resolveObjectNoun(subject).toLowerCase();
  const action = parts[1];
  // Full/action wildcard ("<subject>.*", "<subject>.<action>.*") — no single verb.
  if (!action || action === "*") return `Any ${noun} activity`;
  const past = resolveActionLabel(action, "past").toLowerCase();
  return `${capitalize(withArticle(noun))} was ${past}`;
}

/** The `profileSlug` an event option carries — the object kind it concerns. */
function profileSlugForSubject(subject: string): string | undefined {
  // The generic `entity` base kind's concrete profile is unknown at this layer
  // (the WHERE step binds it); every other subject IS its own object kind.
  return subject === "entity" ? undefined : subject;
}

/**
 * The authoritative "catalog" tier — the emittable-event universe DERIVED from
 * the grammar SSOT (SUBJECT_TYPES × EVENT_ACTIONS) at the `.completed` phase
 * (the phase automations match: `matchForEntity` hardcodes
 * `entity.create.completed`; unified.ts notes "Most automations should use
 * completed"), plus the connector / message-alias / observation families the
 * matcher accepts. Everything here is a pattern `validateEventPattern` accepts.
 */
function buildEventCatalog(): EventOption[] {
  const out: EventOption[] = [];
  const seen = new Set<string>();
  const push = (pattern: string, subject: string) => {
    if (seen.has(pattern)) return;
    seen.add(pattern);
    out.push({
      pattern,
      label: eventLabelFor(pattern, subject),
      profileSlug: profileSlugForSubject(subject),
      source: "catalog",
    });
  };
  for (const subject of SUBJECT_TYPES) {
    for (const action of EVENT_ACTIONS) {
      push(`${subject}.${action}.completed`, subject);
    }
  }
  for (const subject of CONNECTOR_SUBJECT_TYPES) {
    push(`${subject}.*`, subject);
  }
  for (const pattern of MESSAGE_ALIAS_PATTERNS) {
    push(pattern, pattern.split(".")[0]!);
  }
  for (const ns of OBSERVATION_NAMESPACES) {
    push(`${ns}.*`, ns);
  }
  return out;
}

export const automationsRouter = router({
  // ── List automations ────────────────────────────────────────────────────────

  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullable().optional(),
          status: z.enum(["draft", "active", "paused", "error"]).optional(),
          triggerType: z
            .enum(["event", "cron", "webhook", "manual"])
            .optional(),
          limit: z.number().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      // Membership guard from the centralized access layer — without it a
      // caller-supplied workspaceId leaks every workspace's automations.
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );
      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            // Pod-wide floor (`visibility`); a specific workspace only NARROWS,
            // and still includes pod-wide (NULL) rows. No workspace → no narrow.
            input?.workspaceId
              ? or(
                  isNull(automations.workspaceId),
                  eq(automations.workspaceId, input.workspaceId)
                )
              : undefined,
            input?.status ? eq(automations.status, input.status) : undefined,
            input?.triggerType
              ? eq(automations.triggerType, input.triggerType)
              : undefined
          )
        )
        .orderBy(desc(automations.updatedAt), asc(automations.id))
        .limit(input?.limit ?? 50);

      return { automations: rows };
    }),

  /**
   * Cursor-paginated definition list. Kept separate from `list` so existing
   * consumers retain their response shape while completeness-sensitive
   * surfaces can traverse every visible definition.
   */
  listPage: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullable().optional(),
          status: z.enum(["draft", "active", "paused", "error"]).optional(),
          triggerType: z
            .enum(["event", "cron", "webhook", "manual"])
            .optional(),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );
      const cursor = input?.cursor
        ? decodeDefinitionCursor(input.cursor)
        : undefined;
      const limit = input?.limit ?? 50;

      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            input?.workspaceId
              ? or(
                  isNull(automations.workspaceId),
                  eq(automations.workspaceId, input.workspaceId)
                )
              : undefined,
            input?.status ? eq(automations.status, input.status) : undefined,
            input?.triggerType
              ? eq(automations.triggerType, input.triggerType)
              : undefined,
            cursor
              ? or(
                  lt(automations.updatedAt, new Date(cursor.at)),
                  and(
                    eq(automations.updatedAt, new Date(cursor.at)),
                    gt(automations.id, cursor.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(desc(automations.updatedAt), asc(automations.id))
        .limit(limit + 1);

      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        automations: page,
        nextCursor:
          hasNextPage && last
            ? encodeDefinitionCursor({ at: last.updatedAt, id: last.id })
            : null,
      };
    }),

  // ── Feed targets — the static "automation → where its runs land" resolver ────

  /**
   * Backend-accurate answer to "which channel (or subject KIND) does each
   * automation's runs feed into?" — the static counterpart of the runtime
   * `resolveRunChannel` (jobs/utils/post-run-summary.ts). The Atlas "loops" map
   * consumes this instead of the old broad client-side channel approximation.
   *
   * BRANCH ORDER mirrors `resolveRunChannel` EXACTLY:
   *   1. `per_entity` routing + a subject KIND (`triggerConfig.filters.profileSlug`,
   *      the SAME canonical field the trigger-matcher matches on) → the subject
   *      kind, `fansOut:true`. Each run lands in ITS entity's channel at runtime,
   *      so statically we can only name the fan-out KIND. Slug absent ⇒ fall
   *      through (a per_entity automation with no subject filter routes per-type).
   *   2. `triggerConfig.channelId` set → that channel (priority over per_type for
   *      ALL non-per_entity routings, exactly as `resolveRunChannel`).
   *   3. else `per_type` → the automation's durable run channel, resolved
   *      READ-ONLY via `findAutomationRunChannel` (NEVER creates — a read path must
   *      not spawn a channel; `undefined` on a miss just yields no channelId).
   *
   * SCOPING — automations loaded through the SAME scoped predicate + workspace
   * narrow as `list`. Channel TITLES are resolved through the channels
   * VisibilityRule (`scopedDb(...).predicate(channels)`), so a channelId the
   * caller can't see returns its id but no title — never a cross-user title leak.
   */
  feedTargets: protectedProcedure
    .input(
      z
        .object({ workspaceId: z.string().uuid().nullable().optional() })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );
      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            input?.workspaceId
              ? or(
                  isNull(automations.workspaceId),
                  eq(automations.workspaceId, input.workspaceId)
                )
              : undefined
          )
        )
        .orderBy(desc(automations.updatedAt));

      const channelRepo = new ChannelRepository(database);

      // Anonymous (structural) type — a named local interface would leak as a
      // private name into the exported router's inferred type (TS4025).
      const targets: Array<{
        automationId: string;
        mode: "per_type" | "per_entity" | "trigger";
        channelId?: string;
        channelTitle?: string;
        subjectProfileSlug?: string;
        fansOut?: boolean;
      }> = [];
      for (const a of rows) {
        const mode = resolveResultRouting(a.metadata);
        const trigger = a.triggerConfig as AutomationTriggerConfig | null;

        // The branch order is NOT re-derived here — it comes from the same pure
        // door `resolveRunChannel` uses, so this preview cannot drift from where
        // runs actually land. This is a PREDICTION over an automation with no
        // run, so the run-level "does this run have a subject?" question becomes
        // "does this automation have a subject KIND to fan out over?".
        const slug = trigger?.filters?.profileSlug as string | undefined;
        const decision = selectRunChannelBranch({
          routing: mode,
          hasSubject: Boolean(slug),
          triggerChannelId: trigger?.channelId as string | undefined,
        });

        // per_entity + subject KIND → fan out over that kind (no single channel).
        if (decision.branch === "subject_entity") {
          targets.push({
            automationId: a.id,
            mode,
            subjectProfileSlug: slug,
            fansOut: true,
          });
          continue;
        }

        if (decision.branch === "trigger_channel") {
          targets.push({
            automationId: a.id,
            mode,
            channelId: decision.channelId,
          });
          continue;
        }

        // per_type durable run channel — READ-ONLY, never created.
        const runChannel = await channelRepo.findAutomationRunChannel(a.id);
        if (runChannel) {
          targets.push({ automationId: a.id, mode, channelId: runChannel.id });
        } else {
          targets.push({ automationId: a.id, mode });
        }
      }

      // Batch-resolve titles for every collected channelId in ONE scoped IN(...)
      // select. Unseen (unauthorized) channels simply don't appear → no title.
      const channelIds = [
        ...new Set(
          targets
            .map((t) => t.channelId)
            .filter((id): id is string => typeof id === "string")
        ),
      ];
      if (channelIds.length > 0) {
        const chanVisibility = scopedDb(AccessContext.from(ctx)).predicate(
          channels
        );
        const titleRows = await database
          .select({ id: channels.id, title: channels.title })
          .from(channels)
          .where(and(chanVisibility, inArray(channels.id, channelIds)));
        const titleById = new Map(
          titleRows.map((r) => [r.id, r.title] as const)
        );
        for (const t of targets) {
          if (!t.channelId) continue;
          const title = titleById.get(t.channelId);
          if (title) t.channelTitle = title;
        }
      }

      return { targets };
    }),

  // ── Match automations that would fire on creating an entity profile ─────────

  /**
   * Match active automations whose event-trigger would fire on the creation of
   * a given entity profile — the Capture→Automation matcher, mirror of
   * `playbooks.matchForEntity`. Given a captured/created entity's `profileSlug`,
   * answer "is there an automation that reacts to creating this kind of thing?"
   * so the capture done-state can surface + offer to run it.
   *
   * PREDICATE — an automation "would fire on entity.create of profileSlug X"
   * when (source of truth: packages/jobs/src/workers/automation-trigger-matcher.ts):
   *   • status='active' AND triggerType='event'                (matcher :306-310)
   *   • triggerConfig.eventPattern matches the fixed operational event
   *     `entity.create.completed` (events event-types.ts ENTITY_CREATED).
   *     `matchPattern` (:59) accepts it exactly OR via trailing wildcard, so the
   *     matching stored patterns are exactly:
   *       `entity.create.completed` | `entity.create.*` | `entity.*`
   *   • the profileSlug filter passes. Entity events have NO
   *     `matchTriggerSpecificFilters` branch (:112) — profileSlug is a GENERIC
   *     filter (event-types.ts filterKeys:["profileSlug"]) stored at
   *     `triggerConfig.filters.profileSlug` and matched by exact equality
   *     (`matchFilters` :78, applied at :419). An absent filter matches EVERY
   *     profileSlug.
   *
   * SCOPING — `scopedDb(AccessContext.from(ctx)).predicate(automations)` yields
   * the access-layer user floor (never leaks cross-user), narrowed with
   * `or(isNull(workspaceId), eq(workspaceId, input.workspaceId))` EXACTLY like
   * `list`/`get` above: pod-wide (NULL-workspace) globals are KEPT, the target
   * workspace is included, other workspaces (which can never fire for this
   * entity) are excluded. Returns the lean card shape; [] when none.
   */
  matchForEntity: protectedProcedure
    .input(
      z.object({
        profileSlug: z.string().min(1),
        // Round-tripped by the caller into `trigger`/a run as the subject;
        // matching is by profile, so it does not narrow this query.
        entityId: z.string().uuid().optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );

      const rows = await database
        .select()
        .from(automations)
        .where(
          and(
            visibility,
            // Same narrow as `list`: keep pod-wide (NULL) globals + the target
            // workspace; exclude other workspaces.
            or(
              isNull(automations.workspaceId),
              eq(automations.workspaceId, input.workspaceId)
            ),
            eq(automations.status, "active"),
            eq(automations.triggerType, "event"),
            // eventPattern ∈ the set matchPattern accepts for the fixed
            // `entity.create.completed` event.
            drizzleSql`${automations.triggerConfig}->>'eventPattern' = ANY(ARRAY['entity.create.completed','entity.create.*','entity.*'])`,
            // filters.profileSlug absent (fires for any) OR equals the request.
            drizzleSql`(${automations.triggerConfig}->'filters'->>'profileSlug' IS NULL OR ${automations.triggerConfig}->'filters'->>'profileSlug' = ${input.profileSlug})`
          )
        )
        .orderBy(desc(automations.updatedAt));

      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? undefined,
        triggerSummary: summarizeEntityCreateTrigger(a.triggerConfig),
      }));
    }),

  // ── Rules ecosystem: honest WHEN menu ────────────────────────────────────────

  /**
   * The WHEN menu — every trigger event a rule may fire on, UNIONed from three
   * sources and deduped by `pattern` with precedence declared > observed >
   * catalog:
   *   • catalog  — the emittable-event grammar (see `buildEventCatalog`).
   *   • observed — patterns ACTUALLY seen in this user's `events` log, with a
   *                real `observedCount`. `events` has no VisibilityRule (it is
   *                append-only user-owned history), so the access floor is the
   *                RESOLVED userId — never a caller-supplied one (same contract
   *                as hub-protocol/rest/observability.ts). RuleScope narrows.
   *   • declared — `capability --produced--> event` edges in `links`, carrying
   *                the pattern in `metadata.eventPattern`. None exist yet ⇒ []
   *                today (expected); the source is wired so it lights up the
   *                moment a capability declares one.
   */
  availableTriggerEvents: protectedProcedure
    .input(z.object({ scope: ruleScopeSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const scope = input?.scope ?? {};
      const database = await getDb();
      const access = AccessContext.from(ctx);

      // Merge map keyed by pattern; higher-precedence source overwrites but
      // preserves any observedCount already discovered.
      const byPattern = new Map<string, EventOption>();
      for (const opt of buildEventCatalog()) byPattern.set(opt.pattern, opt);

      // ── observed ────────────────────────────────────────────────────────────
      const userId = access.userId;
      if (userId) {
        const wsExpr = drizzleSql`COALESCE(${events.workspaceId}, ${events.data}->>'workspaceId')`;
        const observedRows = await database
          .select({ type: events.type, n: count() })
          .from(events)
          .where(
            and(
              eq(events.userId, userId),
              scope.workspaceId
                ? drizzleSql`${wsExpr} = ${scope.workspaceId}`
                : undefined,
              scope.entityId ? eq(events.subjectId, scope.entityId) : undefined,
              scope.projectId
                ? drizzleSql`${events.data}->>'projectId' = ${scope.projectId}`
                : undefined,
              scope.capabilityId
                ? drizzleSql`${events.data}->>'capabilityId' = ${scope.capabilityId}`
                : undefined,
              scope.channelId
                ? drizzleSql`${events.data}->>'channelId' = ${scope.channelId}`
                : undefined
            )
          )
          .groupBy(events.type);

        for (const row of observedRows) {
          if (!row.type) continue;
          const subject = row.type.split(".")[0]!;
          const existing = byPattern.get(row.type);
          byPattern.set(row.type, {
            pattern: row.type,
            label: existing?.label ?? eventLabelFor(row.type, subject),
            profileSlug:
              existing?.profileSlug ?? profileSlugForSubject(subject),
            source: "observed",
            observedCount: Number(row.n) || 0,
          });
        }
      }

      // ── declared ──────────────────────────────────────────────────────────────
      // The links schema has no dedicated `event` endpoint type / `produces`
      // linkType (LinkEndpointType / LinkType unions in schema/links.ts), so a
      // capability declares a produced event as a `produced` edge whose pattern
      // lives in metadata.eventPattern. Read floor via the links VisibilityRule.
      const linkPred = scopedDb(access).predicate(links);
      const declaredRows = await database
        .select({
          pattern: drizzleSql<
            string | null
          >`${links.metadata}->>'eventPattern'`,
        })
        .from(links)
        .where(
          and(
            linkPred,
            eq(links.fromType, "capability"),
            eq(links.linkType, "produced"),
            drizzleSql`${links.metadata}->>'eventPattern' IS NOT NULL`,
            scope.capabilityId
              ? eq(links.fromId, scope.capabilityId)
              : undefined,
            scope.workspaceId
              ? or(
                  isNull(links.workspaceId),
                  eq(links.workspaceId, scope.workspaceId)
                )
              : undefined
          )
        );

      for (const row of declaredRows) {
        if (!row.pattern) continue;
        let pattern: string;
        try {
          // Defensive: only surface validator-legal declarations.
          pattern = validateEventPattern(row.pattern);
        } catch {
          continue;
        }
        const subject = pattern.split(".")[0]!;
        const existing = byPattern.get(pattern);
        byPattern.set(pattern, {
          pattern,
          label: existing?.label ?? eventLabelFor(pattern, subject),
          profileSlug: existing?.profileSlug ?? profileSlugForSubject(subject),
          source: "declared",
          observedCount: existing?.observedCount,
        });
      }

      // Stable order: declared, then observed (busiest first), then catalog.
      const rank = { declared: 0, observed: 1, catalog: 2 } as const;
      const eventsOut = Array.from(byPattern.values()).sort(
        (a, b) =>
          rank[a.source] - rank[b.source] ||
          (b.observedCount ?? 0) - (a.observedCount ?? 0) ||
          a.pattern.localeCompare(b.pattern)
      );

      return { events: eventOptionSchema.array().parse(eventsOut) };
    }),

  // ── Rules ecosystem: THEN menu ───────────────────────────────────────────────

  /**
   * The THEN menu — every action a rule may take. Always the automation
   * output-node vocabulary (`OUTPUT_NODE_TYPES`); when `scope.capabilityId` is
   * set, also that capability's in-scope VERBS (its member skills — a capability
   * flow node's `verbId` = the requiring skill's name, per `CapabilityNodeDef`),
   * resolved from the `skill --member_of--> capability` links.
   */
  availableActions: protectedProcedure
    .input(z.object({ scope: ruleScopeSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const scope = input?.scope ?? {};
      const access = AccessContext.from(ctx);

      const actions: ActionOption[] = OUTPUT_NODE_TYPES.map((outputType) => ({
        key: outputType,
        label: actionLabelFor(outputType),
        outputType,
      }));

      if (scope.capabilityId) {
        const database = await getDb();
        const linkPred = scopedDb(access).predicate(links);
        const memberSkillRows = await database
          .select({ skillId: links.fromId })
          .from(links)
          .where(
            and(
              linkPred,
              eq(links.toType, "capability"),
              eq(links.toId, scope.capabilityId),
              eq(links.fromType, "skill"),
              eq(links.linkType, "member_of")
            )
          );

        const skillIds = memberSkillRows
          .map((r) => r.skillId)
          .filter((id): id is string => Boolean(id));

        if (skillIds.length > 0) {
          const skillRows = await database
            .select({ id: skills.id, name: skills.name })
            .from(skills)
            .where(
              and(
                visibleSkillsWhere(access.userId, scope.workspaceId),
                inArray(skills.id, skillIds)
              )
            );
          for (const s of skillRows) {
            actions.push({
              key: `capability:${s.name}`,
              label: humanizeToken(s.name),
              outputType: "capability",
            });
          }
        }
      }

      return { actions: actionOptionSchema.array().parse(actions) };
    }),

  // ── Get single automation ───────────────────────────────────────────────────

  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // scopedDb auto-ANDs the visibility predicate, so a foreign workspaceId
      // simply finds nothing instead of leaking the row.
      const row = await scopedDb(AccessContext.from(ctx)).findFirst<
        typeof automations.$inferSelect
      >(automations, {
        where: and(
          eq(automations.id, input.id),
          input.workspaceId
            ? or(
                isNull(automations.workspaceId),
                eq(automations.workspaceId, input.workspaceId)
              )
            : undefined
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      return row;
    }),

  // ── Create automation ───────────────────────────────────────────────────────

  create: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullable().optional(),
          name: z.string().min(1).max(200),
          description: z.string().optional(),
          triggerType: z.enum(["event", "cron", "webhook", "manual"]),
          triggerConfig: z.record(z.string(), z.unknown()).default({}),
          flowDefinition: z.object({
            nodes: z.array(z.record(z.string(), z.unknown())),
            edges: z.array(z.record(z.string(), z.unknown())),
          }),
          status: z
            .enum(["draft", "active", "paused", "error"])
            .default("draft"),
          metadata: z.record(z.string(), z.unknown()).optional(),
          /** Per-automation persistent config/state — resolves {{automation.state.*}}. */
          state: z.record(z.string(), z.unknown()).optional(),
          /** Explicit agent user ID for AI-created automations */
          agentUserId: z.string().uuid().optional(),
          source: z
            .enum(["user", "ai", "intelligence", "system", "agent"])
            .optional(),
        })
        .superRefine(validateAiAutomationDataContract)
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const createdBy = input.agentUserId ?? ctx.userId!;

      await prepareAutomationForMaterialization(database, input, createdBy);

      // Governance membrane. AI agents (agentUserId set) route through
      // checkPermissionOrPropose; on "proposed" no row is written and the
      // proposal id is surfaced. Operator-initiated creates (no agentUserId) are
      // DIRECT writes: an automation is operator configuration (a template /
      // workflow), not AI-authored content. Hub-protocol calls are all branded
      // source:"intelligence", so without this split an operator's own CLI
      // install would otherwise be gated as AI and routed to a proposal. Approved
      // AI creates are materialized separately with their original provenance;
      // RBAC is still enforced on the operator path, which never proposes.
      if (input.agentUserId) {
        const perm = await checkPermissionOrPropose({
          userId: ctx.userId,
          agentUserId: input.agentUserId,
          workspaceId: input.workspaceId ?? null,
          subjectType: "automation",
          action: "create",
          // input.source accepts "user"/"ai"/"agent" (business-provenance values
          // for the `createdVia` metadata below) but those are not valid
          // EventSources — normalize via the canonical guard before this reaches
          // the top-level event source.
          source: normalizeEventSource(input.source),
          // Widened (object-proposal manifest W1): carry the FULL create input so
          // an approved proposal materializes a real automation via
          // automationsRouter.create — not just a labelled shell. This branch is
          // the AI/agent-only governance path (guarded by `if (input.agentUserId)`
          // above), and only the PROPOSED (pending) row's stored data changes; the
          // operator direct-create insert below is byte-untouched.
          data: {
            name: input.name,
            description: input.description,
            triggerType: input.triggerType,
            triggerConfig: input.triggerConfig,
            flowDefinition: input.flowDefinition,
            status: input.status,
            metadata: input.metadata,
            state: input.state,
          },
        });
        if ("denied" in perm && perm.denied) {
          throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
        }
        if ("proposalId" in perm) {
          return {
            status: "proposed" as const,
            id: null as string | null,
            message: "Automation creation proposed for review",
            proposalId: perm.proposalId,
          };
        }
      } else if (input.workspaceId) {
        // Operator direct write — enforce workspace RBAC (deny if not permitted),
        // but never propose. Pod-wide (no workspaceId) is owner-implicit.
        const { verifyPermission } = await import("@synap/database");
        const { requiredPermissionFor } =
          await import("@synap/governance-policy");
        const result = await verifyPermission({
          db: database,
          userId: ctx.userId!,
          workspace: { id: input.workspaceId },
          requiredPermission: requiredPermissionFor("create"),
        });
        if (!result.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: result.reason || "Permission denied",
          });
        }
      }

      // P2-3 (draft-state remedy): reaching here with `agentUserId` set means
      // `automation.create` auto-approved (the proposal branch above already
      // returned) — an agent-authored automation must never fall straight
      // through to a firing state, so force draft regardless of the
      // requested `status`. The operator's own direct create (no
      // agentUserId) keeps its requested status untouched.
      const forceDraft = Boolean(input.agentUserId);
      const automationId = await insertAutomationAfterGovernance(
        database,
        input,
        createdBy,
        undefined,
        forceDraft
      );

      return {
        status: "created" as const,
        id: automationId,
        message: `Automation "${input.name}" created as ${
          forceDraft ? "draft" : input.status
        }`,
        proposalId: null as string | null,
      };
    }),

  // ── Update automation ───────────────────────────────────────────────────────

  update: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
        id: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]).optional(),
        triggerConfig: z.record(z.string(), z.unknown()).optional(),
        flowDefinition: z
          .object({
            nodes: z.array(z.record(z.string(), z.unknown())),
            edges: z.array(z.record(z.string(), z.unknown())),
            precondition: z.string().optional(),
          })
          .optional(),
        status: z.enum(["draft", "active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        state: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      // Load by id ALONE, then gate on the row's real workspace — never the
      // request-supplied workspaceId (that gates nothing).
      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
        columns: {
          id: true,
          workspaceId: true,
          createdBy: true,
          version: true,
          flowDefinition: true,
          triggerType: true,
          triggerConfig: true,
          metadata: true,
        },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      // Validate event pattern on update too
      if (
        input.triggerConfig !== undefined &&
        typeof (input.triggerConfig as Record<string, unknown>)
          ?.eventPattern === "string"
      ) {
        try {
          validateEventPattern(
            (input.triggerConfig as Record<string, unknown>)
              .eventPattern as string
          );
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (err as Error).message,
          });
        }
      }

      // Validate generic `filters` on update too. Gated on the triggerConfig
      // actually being submitted (a partial update that omits it never
      // retroactively rejects an already-persisted automation), and on the
      // effective trigger type being `event` — the only type the matcher applies
      // `filters` for.
      if (input.triggerConfig !== undefined) {
        const effectiveTriggerType = input.triggerType ?? existing.triggerType;
        if (effectiveTriggerType === "event") {
          assertValidTriggerFilters(
            (input.triggerConfig as Record<string, unknown>).filters
          );
        }
      }

      // Node-contract + catalog validation — only the NEW flow being submitted
      // is checked (a no-op update that omits flowDefinition is untouched, so
      // this never retroactively rejects an already-persisted automation).
      if (input.flowDefinition !== undefined) {
        const updateFlowResolvers = await loadFlowValidationResolvers(
          database,
          input.flowDefinition,
          existing.workspaceId,
          existing.createdBy
        );
        const updateFlowError = flowValidationErrorMessage(
          input.flowDefinition,
          updateFlowResolvers
        );
        if (updateFlowError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: updateFlowError,
          });
        }

        // Keep the template-friendly skillName form executable on update too,
        // matching create's pre-persist normalization.
        await injectSkillIdsFromNames(
          database,
          input.flowDefinition,
          existing.workspaceId,
          existing.createdBy
        );
      }

      const existingMetadata =
        existing.metadata &&
        typeof existing.metadata === "object" &&
        !Array.isArray(existing.metadata)
          ? (existing.metadata as Record<string, unknown>)
          : {};
      const effectiveMetadata =
        input.metadata === undefined
          ? existingMetadata
          : {
              ...existingMetadata,
              ...input.metadata,
              ...(existingMetadata.createdVia !== undefined
                ? { createdVia: existingMetadata.createdVia }
                : {}),
            };
      const effectiveDataContract = effectiveMetadata.dataContract;
      if (
        existingMetadata.createdVia === "ai" &&
        effectiveDataContract === undefined
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "AI-authored automations must keep an explicit Gets data / Stores in Synap / Reacts & sends contract.",
        });
      }

      if (effectiveDataContract !== undefined) {
        const submittedContract = automationDataContractSchema.safeParse(
          effectiveDataContract
        );
        if (!submittedContract.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            // Name the broken rule — see `describeContractIssues`. "is invalid"
            // alone gives an agent nothing to correct.
            message: `The submitted Gets data / Stores in Synap / Reacts & sends contract is invalid: ${describeContractIssues(
              submittedContract.error
            )}`,
          });
        }
        const contractIssues = findUnknownDataContractNodeReferences(
          submittedContract.data,
          (input.flowDefinition ?? existing.flowDefinition) as {
            nodes: Array<Record<string, unknown>>;
          }
        );
        if (contractIssues.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Data contract references unknown flow node "${contractIssues[0]?.nodeId}".`,
          });
        }
      }

      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.triggerType !== undefined)
        updates.triggerType = input.triggerType;
      if (input.triggerConfig !== undefined)
        updates.triggerConfig = input.triggerConfig;
      if (input.flowDefinition !== undefined)
        updates.flowDefinition = input.flowDefinition;
      if (input.status !== undefined) updates.status = input.status;
      if (input.metadata !== undefined) updates.metadata = effectiveMetadata;
      if (input.state !== undefined) updates.state = input.state;

      // Bump the monotonic definition version when a definition-affecting
      // field actually changes (compared against the loaded row, so a rename or
      // status toggle doesn't inflate it). Stamped into each run's
      // definitionSnapshot so "what ran" can be diffed against "today".
      const definitionChanged =
        (updates.flowDefinition !== undefined &&
          stableStringify(updates.flowDefinition) !==
            stableStringify(existing.flowDefinition)) ||
        (updates.triggerType !== undefined &&
          updates.triggerType !== existing.triggerType) ||
        (updates.triggerConfig !== undefined &&
          stableStringify(updates.triggerConfig) !==
            stableStringify(existing.triggerConfig));
      if (definitionChanged) updates.version = (existing.version ?? 1) + 1;

      await database
        .update(automations)
        .set(updates)
        .where(eq(automations.id, input.id));

      return {
        status: "updated",
        message: `Automation updated`,
      };
    }),

  // ── Delete automation ───────────────────────────────────────────────────────

  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
        columns: { id: true, workspaceId: true, createdBy: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      await database.delete(automations).where(eq(automations.id, input.id));

      return { status: "deleted" };
    }),

  // ── Activate / Pause ───────────────────────────────────────────────────────

  activate: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });
      if (existing.status === "active") {
        return { status: "already_active" };
      }

      // For cron triggers, compute the next run time
      let nextRunAt: Date | null = null;
      if (existing.triggerType === "cron") {
        const triggerConfig = existing.triggerConfig as Record<string, unknown>;
        const cronExpression = triggerConfig?.expression as string | undefined;
        if (cronExpression) {
          nextRunAt = computeNextCronRunAt(cronExpression, new Date());
        }
      }

      await database
        .update(automations)
        .set({
          status: "active",
          updatedAt: new Date(),
          errorMessage: null,
          ...(nextRunAt ? { nextRunAt } : {}),
        })
        .where(eq(automations.id, input.id));

      return { status: "activated", nextRunAt: nextRunAt?.toISOString() };
    }),

  pause: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
        columns: {
          id: true,
          status: true,
          workspaceId: true,
          createdBy: true,
        },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      await database
        .update(automations)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(automations.id, input.id));

      return { status: "paused" };
    }),

  // ── Runs: list ──────────────────────────────────────────────────────────────

  listRuns: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().nullable().optional(),
        automationId: z.string().uuid(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();

      // Verify the automation is visible to this caller (membership-gated via
      // the access layer) BEFORE returning its run history.
      const automation = await scopedDb(AccessContext.from(ctx)).findFirst<{
        id: string;
      }>(automations, {
        where: and(
          eq(automations.id, input.automationId),
          input.workspaceId
            ? or(
                isNull(automations.workspaceId),
                eq(automations.workspaceId, input.workspaceId)
              )
            : undefined
        ),
        columns: { id: true },
      });
      if (!automation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }

      const rows = await database
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, input.automationId))
        .orderBy(desc(automationRuns.startedAt))
        .limit(input.limit ?? 20);

      return { runs: rows };
    }),

  // ── Runs: get with step runs ────────────────────────────────────────────────

  getRun: protectedProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const database = await getDb();

      const run = await scopedDb(AccessContext.from(ctx)).findFirst<
        typeof automationRuns.$inferSelect
      >(automationRuns, {
        where: and(
          eq(automationRuns.id, input.runId),
          input.workspaceId
            ? or(
                isNull(automationRuns.workspaceId),
                eq(automationRuns.workspaceId, input.workspaceId)
              )
            : undefined
        ),
      });
      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Run not found",
        });
      }

      const steps = await database
        .select()
        .from(automationStepRuns)
        .where(eq(automationStepRuns.runId, run.id));

      return { run, steps };
    }),

  // ── AI: Diagnose run ────────────────────────────────────────────────────────

  diagnoseRun: protectedProcedure
    .input(
      z.object({
        automationName: z.string(),
        flowDefinition: z.record(z.string(), z.unknown()),
        run: z.object({
          id: z.string(),
          status: z.string(),
          startedAt: z.string(),
          finishedAt: z.string().optional(),
          errorMessage: z.string().optional(),
        }),
        steps: z.array(
          z.object({
            nodeId: z.string(),
            nodeType: z.string(),
            status: z.string(),
            resolvedInputs: z.record(z.string(), z.unknown()).optional(),
            output: z.record(z.string(), z.unknown()).optional(),
            errorMessage: z.string().optional(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Canonical IS credential resolution (decrypted DB key), not stale env.
      const { endpoint: isUrl, apiKey: isApiKey } =
        await getDefaultActiveService();

      const response = await fetch(`${isUrl}/api/automations/diagnose-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({
          workspaceId: ctx.workspaceId ?? null,
          userId: ctx.userId,
          ...input,
        }),
      });

      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "IS call failed",
        });
      }

      return response.json() as Promise<{
        explanation: string;
        suggestions: string[];
      }>;
    }),

  // ── AI: Generate flow ───────────────────────────────────────────────────────

  generateFlow: protectedProcedure
    .input(
      z.object({
        prompt: z.string().min(1).max(2000),
        existingFlow: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Canonical IS credential resolution (decrypted DB key), not stale env.
      const { endpoint: isUrl, apiKey: isApiKey } =
        await getDefaultActiveService();

      const response = await fetch(`${isUrl}/api/automations/generate-flow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({
          workspaceId: ctx.workspaceId ?? null,
          userId: ctx.userId,
          ...input,
        }),
      });

      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "IS call failed",
        });
      }

      return response.json() as Promise<{
        flowDefinition: { nodes: unknown[]; edges: unknown[] };
        name: string;
        explanation: string;
      }>;
    }),

  // ── Manual trigger ──────────────────────────────────────────────────────────

  trigger: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
        /** Durable entity lens for this run (separate from arbitrary payload). */
        subjectEntityId: z.string().uuid().optional(),
        /** Optional payload to inject as trigger.payload in the execution context */
        payload: z.record(z.string(), z.unknown()).optional(),
        /** Explicit agent user ID when an AI agent asks for the run (governed). */
        agentUserId: z.string().uuid().optional(),
        /** AI reasoning surfaced on the proposal card. */
        reasoning: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const { getBoss } = await import("@synap/jobs");

      const existing = await database.query.automations.findFirst({
        where: eq(automations.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Automation not found",
        });
      }
      if (input.workspaceId && input.workspaceId !== existing.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "workspaceId does not match the automation workspace.",
        });
      }
      // Gate on the row's real workspace — triggering is cross-workspace
      // CODE EXECUTION, so this guard is critical.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });
      // An explicit manual trigger bypasses the normal trigger config, so a
      // DRAFT is test-runnable on demand (e.g. run a draft cron once before
      // activating it). Only paused/error block a non-manual-type automation —
      // those states signal "do not run".
      const runnableStatus =
        existing.status === "active" || existing.status === "draft";
      if (!runnableStatus && existing.triggerType !== "manual") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot trigger automation with status="${existing.status}". Activate it, or use a manual trigger type.`,
        });
      }
      // Governance membrane for the AGENT caller. Triggering runs the whole
      // flow — including `webhook` and `command` nodes — so this is CODE
      // EXECUTION, strictly wider than `run_command`, which IS gated
      // (hub-protocol/rest/commands.ts `POST /commands/execute`). `automation`
      // + `execute` mirrors that door's `{command, execute}` pair and reuses an
      // already-inventoried verb (`requiredPermissionFor("execute") = "write"`).
      // `automation.execute` is NOT in DEFAULT_AUTO_APPROVE, so an agent run
      // routes to a proposal.
      //
      // Operator-initiated triggers are DIRECT, exactly like the create door:
      // gate only `if (agentUserId)`. Hub-protocol calls are all branded
      // source:"intelligence", so gating on source would send an operator's own
      // UI/CLI "run now" to a proposal. RBAC for the operator path is unchanged
      // (assertWorkspaceWrite above); the agent path additionally runs the gate,
      // which owns the agent's own RBAC + propose/execute decision.
      const agentUserId = input.agentUserId ?? ctx.agentUserId ?? undefined;
      if (agentUserId) {
        const perm = await checkPermissionOrPropose({
          userId: ctx.userId!,
          agentUserId,
          workspaceId: existing.workspaceId ?? null,
          subjectType: "automation",
          action: "execute",
          source: "intelligence",
          data: {
            automationId: existing.id,
            name: existing.name,
            triggerType: existing.triggerType,
            payload: input.payload,
            subjectEntityId: input.subjectEntityId,
          },
          reasoning: input.reasoning,
        });
        if ("denied" in perm && perm.denied) {
          throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
        }
        if ("proposalId" in perm) {
          return {
            status: "proposed" as const,
            runId: null as string | null,
            proposalId: perm.proposalId as string | null,
            message: `Running "${existing.name}" proposed for review`,
          };
        }
      }

      // Older generic action renderers send the entity in payload. Accept that
      // compatibility shape via the shared subject door (which enforces the
      // UUID-only rule every run-creating path shares); callers can use the
      // explicit input for new integrations.
      const subjectEntityId =
        input.subjectEntityId ?? subjectEntityIdFromPayload(input.payload);

      const [run] = await database
        .insert(automationRuns)
        .values({
          automationId: existing.id,
          workspaceId: existing.workspaceId,
          subjectEntityId,
          triggeredBy: ctx.userId!,
          triggerPayload: {
            type: "manual",
            triggeredBy: ctx.userId!,
            timestamp: new Date().toISOString(),
            ...(input.payload ?? {}),
          },
          status: "running",
        })
        .returning({ id: automationRuns.id });

      const boss = getBoss();
      await boss.send("automation-execute", {
        runId: run.id,
        automationId: existing.id,
        workspaceId: existing.workspaceId,
        automationContext: {
          automationRunId: run.id,
          automationId: existing.id,
          chainDepth: 0,
          rootRunId: run.id,
          chainAutomationIds: [existing.id],
        },
      });

      return {
        status: "triggered" as const,
        runId: run.id as string | null,
        proposalId: null as string | null,
      };
    }),
});
