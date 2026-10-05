/**
 * Which PROPOSE-MODE RULES does a capture fire? — the automation half of the
 * capture follow-up's route suggestions.
 *
 * ── Why this replaced `automations.matchForEntity` ──────────────────────────
 * That procedure was a SECOND trigger predicate: an SQL
 * `eventPattern = ANY(ARRAY['entity.create.completed','entity.create.*','entity.*'])`
 * plus `filters.profileSlug` equality. It could see neither operator filters,
 * nor rule scope (entity/project), nor the sync-origin opt-in — so it offered
 * rules that would never fire and missed ones that would. And it offered
 * AUTO rules, which already ran on their own the moment the capture emitted
 * `entity.create.completed`: a chip for a rule that already fired is a double.
 *
 * Now: the candidate rows come through the access layer exactly as before
 * (`scopedDb(...).predicate(automations)`, narrowed to the target workspace +
 * pod-wide), and the DECISION is the trigger matcher's own pure function,
 * `automationTriggerMatches` (@synap/jobs) — the live loop calls the same
 * function, so "a rule this capture fires" and "a rule that fires" cannot
 * disagree. Only PROPOSE rules are returned (`ruleActMode`): an auto rule needs
 * no suggestion, it ran.
 *
 * The event is the one `capture.execute` emits per created entity
 * (`emitSideEffects({ subjectType: "entity", action: "create", data: { source:
 * "capture", profileSlug } })`) — reconstructed, not re-invented.
 *
 * Also returns the playbook ids a visible propose rule already targets, so the
 * "Always propose this" offer on a playbook chip is withheld when a standing
 * rule for it exists.
 */

import {
  getDb,
  and,
  eq,
  or,
  isNull,
  desc,
  automations,
  type AutomationTriggerConfig,
} from "@synap/database";
import {
  automationTriggerMatches,
  deriveMessageEnvelope,
  deriveEventScopeEntityId,
  resolveEventProjectIds,
} from "@synap/jobs/workers/automation-trigger-matcher.js";
import {
  ruleActMode,
  readPlaybookRunMode,
} from "@synap-core/types/automations";
import { AccessContext, scopedDb } from "../../access/index.js";

/** The event `capture.execute` emits for each entity it creates. */
export const CAPTURE_ENTITY_EVENT = "entity.create.completed";

export interface RuleCandidateRow {
  id: string;
  name: string;
  description: string | null;
  triggerConfig: unknown;
  flowDefinition: unknown;
}

export interface ProposeRuleMatch {
  id: string;
  name: string;
  description: string | null;
  /** The kind the rule's own filter names; `null` = it fires for any kind. */
  filterProfileSlug: string | null;
}

export interface ProposeRuleMatches {
  matches: ProposeRuleMatch[];
  /** Playbooks a visible propose rule already proposes (any trigger). */
  proposedPlaybookIds: ReadonlySet<string>;
}

/** Playbook ids a flow's propose-mode `playbook_run` nodes target. */
function proposedPlaybookIdsOf(flowDefinition: unknown): string[] {
  const nodes = (flowDefinition as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n) => {
    const node = n as { type?: unknown; data?: Record<string, unknown> };
    if (node?.type !== "playbook_run") return [];
    if (readPlaybookRunMode(node.data?.mode) !== "propose") return [];
    const id = node.data?.playbookId;
    return typeof id === "string" && id ? [id] : [];
  });
}

/**
 * The pure decision over already-loaded rows: which propose rules the capture
 * event for this entity fires. `projectIds` is the event's project
 * membership, or `null` when no candidate is project-scoped (the matcher's own
 * convention).
 */
export function selectProposeRuleMatches(input: {
  rows: readonly RuleCandidateRow[];
  entityId?: string;
  profileSlug: string;
  projectIds: ReadonlySet<string> | null;
}): ProposeRuleMatches {
  const data = { source: "capture", profileSlug: input.profileSlug };
  const subjectId = input.entityId ?? "";
  const scopeFacts = {
    entityId: deriveEventScopeEntityId({
      eventType: CAPTURE_ENTITY_EVENT,
      subjectId,
      data,
    }),
    projectIds: input.projectIds,
  };
  const messageEnvelope = deriveMessageEnvelope(CAPTURE_ENTITY_EVENT, data);

  const proposeRows = input.rows.filter(
    (r) => ruleActMode(r.flowDefinition) === "propose"
  );
  const proposedPlaybookIds = new Set(
    proposeRows.flatMap((r) => proposedPlaybookIdsOf(r.flowDefinition))
  );
  const matches = proposeRows
    .filter((r) =>
      automationTriggerMatches({
        eventType: CAPTURE_ENTITY_EVENT,
        data,
        config: (r.triggerConfig ?? {}) as AutomationTriggerConfig,
        messageEnvelope,
        scopeFacts,
      })
    )
    .map((r) => {
      const slug = (r.triggerConfig as AutomationTriggerConfig | null)?.filters
        ?.profileSlug;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        filterProfileSlug: typeof slug === "string" ? slug : null,
      };
    });
  return { matches, proposedPlaybookIds };
}

/** Load the caller-visible active event rules for a workspace lens. */
export async function loadRuleCandidates(
  ctx: Record<string, unknown>,
  workspaceId: string
): Promise<RuleCandidateRow[]> {
  const database = await getDb();
  const visibility = scopedDb(
    AccessContext.from(ctx as Parameters<typeof AccessContext.from>[0])
  ).predicate(automations);
  return database
    .select({
      id: automations.id,
      name: automations.name,
      description: automations.description,
      triggerConfig: automations.triggerConfig,
      flowDefinition: automations.flowDefinition,
    })
    .from(automations)
    .where(
      and(
        visibility,
        // Pod-wide globals + the target workspace — the lens the live matcher
        // fires in; other workspaces can never fire for this entity.
        or(
          isNull(automations.workspaceId),
          eq(automations.workspaceId, workspaceId)
        ),
        eq(automations.status, "active"),
        eq(automations.triggerType, "event")
      )
    )
    .orderBy(desc(automations.updatedAt));
}

/** Rows → matches for one captured entity, reading project membership only when a rule needs it. */
export async function matchProposeRulesForEntity(input: {
  rows: readonly RuleCandidateRow[];
  entityId?: string;
  profileSlug: string;
}): Promise<ProposeRuleMatches> {
  const needsProjects = input.rows.some(
    (r) =>
      typeof (r.triggerConfig as AutomationTriggerConfig | null)?.projectId ===
      "string"
  );
  const data = { source: "capture", profileSlug: input.profileSlug };
  const projectIds =
    needsProjects && input.entityId
      ? await resolveEventProjectIds({
          eventType: CAPTURE_ENTITY_EVENT,
          subjectId: input.entityId,
          data,
          entityId: input.entityId,
        })
      : null;
  return selectProposeRuleMatches({ ...input, projectIds });
}
