/**
 * readSessionUsage — the ONE door for "what did this session USE?", the read
 * behind the desktop session page's "In this session" block (founder decision
 * 2026-09-24).
 *
 * Usage has no ledger of its own. It is assembled from the stores that already
 * record it, each kept to what it can honestly say:
 *
 *   1. CAPABILITY RUNS — counted. The SAME two predicates the runs feed reads
 *      (`services/runs/capability-run-where.ts`): `capability.run` proposals on
 *      `proposals.session_id`, and direct-run `capability_run` events on
 *      `events.session_id`. Only runs that RAN count: an executed proposal
 *      (approved / auto-approved) or a delivered direct run. A pending or
 *      rejected proposal did not run; a REFUSED attempt rides the same event
 *      kind with `data.outcome = "refused"` and never ran either.
 *      A proposed→approved run whose event ALSO carries the session is counted
 *      ONCE (the event is dropped when its correlationId belongs to a proposal
 *      in the same lens) — the same dedupe the runs feed does in memory.
 *   2. CONNECTORS — DERIVED, and marked so (`via`). A run does not persist the
 *      connector it went through, so it is inferred per skill: the skill's
 *      capability container (`skill --member_of--> capability`) and the
 *      provider/mcp/api tool that is a member of that same container; failing
 *      that, the declarative skill's own `provider_spec.tool`.
 *   3. RECORDED — `session --used--> tool|skill|command` edges, written by the
 *      IS tool-wrapper and `runs.capture` at the moment of use. PROVENANCE, not a
 *      count: the edge is unique, so it says "was used" and when first.
 *   4. GRANTED — `session --grants--> tool|skill|command|capability`. What the
 *      session was ALLOWED to use. Never merged into used: a grant nobody
 *      exercised is not usage, and reading it as such is the lie this block
 *      exists to avoid. (`vault_grants` rows carry no session id, so the
 *      enforcement row cannot be attributed to a session — the edge is the
 *      only session-keyed grant record.)
 *   5. PLAYBOOK — `focus_sessions.playbook_id`, else the newest
 *      `playbook_runs.session_id` row.
 *   6. AGENTS — `attachSessionParticipants`' roster, reused, never re-derived.
 *
 * A failed read THROWS. Nothing here catches into an empty list: an empty
 * "In this session" block must mean the session used nothing, never that a
 * query broke.
 */

import {
  db,
  and,
  eq,
  inArray,
  desc,
  drizzleSql,
  focusSessions,
  proposals,
  events,
  links,
  tools,
  skills,
  capabilities,
  playbooks,
  playbookRuns,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { notExists } from "drizzle-orm";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { REFUSED_OUTCOME } from "../../lib/run-event-kinds.js";
import {
  capabilityRunEventWhere,
  capabilityRunProposalWhere,
} from "../runs/capability-run-where.js";
import {
  withSessionParticipants,
  type SessionParticipant,
} from "./participants.js";
import { UUID_RE } from "./session-metadata.js";

/** One capability (skill) the session ran, with how often and how recently. */
export interface SessionUsageCapability {
  skillId: string;
  /** The skill's name; the verb id when the skill row is not visible. */
  name: string;
  /** The verb id the run was invoked by, when one was recorded. */
  verb: string | null;
  count: number;
  lastUsedAt: Date;
}

/**
 * How a connector was attributed to the session's runs. Always an INFERENCE —
 * no run records its connector.
 */
export type SessionUsageConnectorVia =
  | { kind: "capability"; capabilityId: string; capabilityName: string }
  | { kind: "provider_spec"; skillId: string };

/** A connector (external service) the session's capability runs went through. */
export interface SessionUsageConnector {
  /** The tool row id; the provider key for a `provider_spec` attribution. */
  id: string;
  /** Non-null when a pod `tools` row backs this connector. */
  toolId: string | null;
  name: string;
  /** Service-mark id (`@synap-core/types/service-marks`), when one is known. */
  serviceId: string | null;
  /** Sum of the runs of every skill attributed to this connector. */
  count: number;
  lastUsedAt: Date;
  via: SessionUsageConnectorVia;
}

export type SessionPartKind = "tool" | "skill" | "command";
export type SessionGrantKind = SessionPartKind | "capability";

/** A `session --used--> part` provenance edge. */
export interface SessionUsageRecorded {
  kind: SessionPartKind;
  id: string;
  /** Null when the row is not visible or the kind has no named table. */
  name: string | null;
  firstUsedAt: Date;
}

/** A `session --grants--> part|capability` edge — permission, not usage. */
export interface SessionUsageGrant {
  kind: SessionGrantKind;
  id: string;
  name: string | null;
  grantedAt: Date;
}

export interface SessionUsage {
  sessionId: string;
  capabilities: SessionUsageCapability[];
  connectors: SessionUsageConnector[];
  recorded: SessionUsageRecorded[];
  granted: SessionUsageGrant[];
  /** `name` is null when the playbook row is gone or not visible. */
  playbook: { id: string; name: string | null } | null;
  agents: SessionParticipant[];
}

const EXECUTED_PROPOSAL_STATUSES = [
  ProposalStatus.APPROVED,
  ProposalStatus.AUTO_APPROVED,
];

const PART_KINDS: readonly SessionPartKind[] = ["tool", "skill", "command"];
const GRANT_KINDS: readonly SessionGrantKind[] = [...PART_KINDS, "capability"];

/** Tool kinds that reach an external service — what "connector" means here. */
const CONNECTOR_TOOL_KINDS = ["provider", "mcp", "api"] as const;

const isUuid = (v: string) => UUID_RE.test(v);

/**
 * The capability runs of one session, aggregated per skill. Two grouped reads
 * (never a row list — a sync-heavy session can hold thousands of runs), merged
 * in memory by skill id.
 */
async function aggregateCapabilityRuns(
  userId: string,
  sessionId: string
): Promise<
  Map<string, { verb: string | null; count: number; lastUsedAt: Date }>
> {
  const proposalSkill = proposals.targetId;
  const eventSkill = drizzleSql<string>`${events.data}->>'skillId'`;

  const [proposalRows, eventRows] = await Promise.all([
    db
      .select({
        skillId: proposalSkill,
        verb: drizzleSql<string | null>`max(${proposals.data}->>'verbId')`,
        count: drizzleSql<number>`count(*)`.mapWith(Number),
        lastUsedAt:
          drizzleSql<Date>`max(coalesce(${proposals.reviewedAt}, ${proposals.createdAt}))`.mapWith(
            proposals.createdAt
          ),
      })
      .from(proposals)
      .where(
        and(
          capabilityRunProposalWhere(userId, { sessionId }),
          inArray(proposals.status, EXECUTED_PROPOSAL_STATUSES)
        )
      )
      .groupBy(proposalSkill),
    db
      .select({
        skillId: eventSkill,
        verb: drizzleSql<string | null>`max(${events.data}->>'verbId')`,
        count: drizzleSql<number>`count(*)`.mapWith(Number),
        lastUsedAt: drizzleSql<Date>`max(${events.timestamp})`.mapWith(
          events.timestamp
        ),
      })
      .from(events)
      .where(
        and(
          capabilityRunEventWhere(userId, { sessionId }),
          // A refusal never ran. Absence of `outcome` means delivered.
          drizzleSql`${events.data}->>'outcome' IS DISTINCT FROM ${REFUSED_OUTCOME}`,
          // A proposed→approved run already counted by its proposal.
          notExists(
            db
              .select({ one: drizzleSql`1` })
              .from(proposals)
              .where(
                and(
                  eq(proposals.correlationId, events.correlationId),
                  capabilityRunProposalWhere(userId, { sessionId })
                )
              )
          )
        )
      )
      .groupBy(eventSkill),
  ]);

  const bySkill = new Map<
    string,
    { verb: string | null; count: number; lastUsedAt: Date }
  >();
  for (const row of [...proposalRows, ...eventRows]) {
    if (!row.skillId) continue;
    const prev = bySkill.get(row.skillId);
    if (!prev) {
      bySkill.set(row.skillId, {
        verb: row.verb ?? null,
        count: row.count,
        lastUsedAt: row.lastUsedAt,
      });
      continue;
    }
    prev.count += row.count;
    if (row.lastUsedAt > prev.lastUsedAt) prev.lastUsedAt = row.lastUsedAt;
    prev.verb = prev.verb ?? row.verb ?? null;
  }
  return bySkill;
}

/** Service-mark id of a connector tool: its provider config key, else its nango ref. */
function toolServiceId(tool: {
  config: unknown;
  credentialRef: string | null;
}): string | null {
  const config = tool.config as { providerConfigKey?: unknown } | null;
  if (typeof config?.providerConfigKey === "string" && config.providerConfigKey)
    return config.providerConfigKey;
  const m = /^nango:\/\/(.+)$/.exec(tool.credentialRef ?? "");
  return m ? m[1]! : null;
}

/**
 * Attribute connectors to the counted skills. Returns, per skill, the
 * connector(s) its runs are inferred to have gone through.
 */
async function deriveConnectors(
  userId: string,
  skillRows: Array<{ id: string; providerSpec: unknown }>,
  runs: Map<string, { count: number; lastUsedAt: Date }>
): Promise<SessionUsageConnector[]> {
  const skillIds = skillRows.map((s) => s.id);
  if (skillIds.length === 0) return [];

  // skill --member_of--> capability
  const skillMemberships = await db
    .select({ skillId: links.fromId, capabilityId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.linkType, "member_of"),
        eq(links.fromType, "skill"),
        inArray(links.fromId, skillIds),
        eq(links.toType, "capability"),
        userVisibleWhere(links.workspaceId, userId)
      )
    );
  const capabilityIds = [
    ...new Set(skillMemberships.map((m) => m.capabilityId)),
  ].filter(isUuid);

  // tool --member_of--> that capability, where the tool reaches a service.
  const [toolMemberships, capabilityRows] =
    capabilityIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              capabilityId: links.toId,
              toolId: tools.id,
              toolName: tools.name,
              config: tools.config,
              credentialRef: tools.credentialRef,
            })
            .from(links)
            .innerJoin(tools, drizzleSql`${tools.id}::text = ${links.fromId}`)
            .where(
              and(
                eq(links.linkType, "member_of"),
                eq(links.fromType, "tool"),
                eq(links.toType, "capability"),
                inArray(links.toId, capabilityIds),
                userVisibleWhere(links.workspaceId, userId),
                inArray(tools.kind, [...CONNECTOR_TOOL_KINDS]),
                userVisibleWhere(tools.workspaceId, userId)
              )
            ),
          db
            .select({ id: capabilities.id, name: capabilities.name })
            .from(capabilities)
            .where(
              and(
                inArray(capabilities.id, capabilityIds),
                userVisibleWhere(capabilities.workspaceId, userId)
              )
            ),
        ]);
  const capabilityName = new Map(capabilityRows.map((c) => [c.id, c.name]));

  const byId = new Map<string, SessionUsageConnector>();
  const credit = (
    base: Omit<SessionUsageConnector, "count" | "lastUsedAt">,
    run: { count: number; lastUsedAt: Date }
  ) => {
    const prev = byId.get(base.id);
    if (!prev) {
      byId.set(base.id, {
        ...base,
        count: run.count,
        lastUsedAt: run.lastUsedAt,
      });
      return;
    }
    prev.count += run.count;
    if (run.lastUsedAt > prev.lastUsedAt) prev.lastUsedAt = run.lastUsedAt;
  };

  for (const skill of skillRows) {
    const run = runs.get(skill.id);
    if (!run) continue;
    const skillCapabilities = new Set(
      skillMemberships
        .filter((m) => m.skillId === skill.id)
        .map((m) => m.capabilityId)
    );
    // A tool in two of this skill's containers is still ONE connector for it.
    const creditedTools = new Set<string>();
    for (const t of toolMemberships) {
      if (!skillCapabilities.has(t.capabilityId)) continue;
      if (!capabilityName.has(t.capabilityId)) continue;
      if (creditedTools.has(t.toolId)) continue;
      creditedTools.add(t.toolId);
      const serviceId = toolServiceId(t);
      credit(
        {
          id: t.toolId,
          toolId: t.toolId,
          name: serviceId ? resolveServiceName(serviceId) : t.toolName,
          serviceId,
          via: {
            kind: "capability",
            capabilityId: t.capabilityId,
            capabilityName: capabilityName.get(t.capabilityId)!,
          },
        },
        run
      );
    }
    if (creditedTools.size > 0) continue;

    // Fallback: a declarative skill names its provider in its own spec.
    const spec = skill.providerSpec as { tool?: unknown } | null;
    if (typeof spec?.tool === "string" && spec.tool) {
      credit(
        {
          id: spec.tool,
          toolId: null,
          name: resolveServiceName(spec.tool),
          serviceId: spec.tool,
          via: { kind: "provider_spec", skillId: skill.id },
        },
        run
      );
    }
  }

  return [...byId.values()].sort(
    (a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime()
  );
}

/** Resolve display names for tool / skill / capability ids, floored. */
async function resolvePartNames(
  userId: string,
  refs: Array<{ kind: SessionGrantKind; id: string }>
): Promise<Map<string, string>> {
  const idsOf = (kind: SessionGrantKind) =>
    [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))].filter(
      isUuid
    );
  const toolIds = idsOf("tool");
  const skillIds = idsOf("skill");
  const capabilityIds = idsOf("capability");
  const [toolRows, skillRows, capabilityRows] = await Promise.all([
    toolIds.length === 0
      ? []
      : db
          .select({ id: tools.id, name: tools.name })
          .from(tools)
          .where(
            and(
              inArray(tools.id, toolIds),
              userVisibleWhere(tools.workspaceId, userId)
            )
          ),
    skillIds.length === 0
      ? []
      : db
          .select({ id: skills.id, name: skills.name })
          .from(skills)
          .where(
            and(
              inArray(skills.id, skillIds),
              userVisibleWhere(skills.workspaceId, userId)
            )
          ),
    capabilityIds.length === 0
      ? []
      : db
          .select({ id: capabilities.id, name: capabilities.name })
          .from(capabilities)
          .where(
            and(
              inArray(capabilities.id, capabilityIds),
              userVisibleWhere(capabilities.workspaceId, userId)
            )
          ),
  ]);
  const names = new Map<string, string>();
  for (const r of toolRows) names.set(`tool:${r.id}`, r.name);
  for (const r of skillRows) names.set(`skill:${r.id}`, r.name);
  for (const r of capabilityRows) names.set(`capability:${r.id}`, r.name);
  return names;
}

async function resolvePlaybook(
  userId: string,
  session: { id: string; playbookId: string | null }
): Promise<SessionUsage["playbook"]> {
  let playbookId = session.playbookId;
  if (!playbookId) {
    const [run] = await db
      .select({ playbookId: playbookRuns.playbookId })
      .from(playbookRuns)
      .where(eq(playbookRuns.sessionId, session.id))
      .orderBy(desc(playbookRuns.startedAt))
      .limit(1);
    playbookId = run?.playbookId ?? null;
  }
  if (!playbookId) return null;
  const [row] = await db
    .select({ name: playbooks.name })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.id, playbookId),
        userVisibleWhere(playbooks.workspaceId, userId)
      )
    )
    .limit(1);
  return { id: playbookId, name: row?.name ?? null };
}

/**
 * Returns `null` when the session does not exist OR is not the caller's — the
 * same owner floor every `focusSessions` read door uses, so the two are
 * indistinguishable to the caller (the router maps it to NOT_FOUND).
 */
export async function readSessionUsage(params: {
  userId: string;
  sessionId: string;
}): Promise<SessionUsage | null> {
  const { userId, sessionId } = params;
  if (!isUuid(sessionId)) return null;

  const [session] = await db
    .select({
      id: focusSessions.id,
      agentIds: focusSessions.agentIds,
      playbookId: focusSessions.playbookId,
    })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
    )
    .limit(1);
  if (!session) return null;

  const [runs, edgeRows, playbook, staffed] = await Promise.all([
    aggregateCapabilityRuns(userId, sessionId),
    db
      .select({
        linkType: links.linkType,
        toType: links.toType,
        toId: links.toId,
        createdAt: links.createdAt,
      })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.fromId, sessionId),
          inArray(links.linkType, ["used", "grants"]),
          userVisibleWhere(links.workspaceId, userId)
        )
      ),
    resolvePlaybook(userId, session),
    withSessionParticipants(session, userId),
  ]);

  const runSkillIds = [...runs.keys()].filter(isUuid);
  const skillRows =
    runSkillIds.length === 0
      ? []
      : await db
          .select({
            id: skills.id,
            name: skills.name,
            providerSpec: skills.providerSpec,
          })
          .from(skills)
          .where(
            and(
              inArray(skills.id, runSkillIds),
              userVisibleWhere(skills.workspaceId, userId)
            )
          );
  const skillName = new Map(skillRows.map((s) => [s.id, s.name]));

  const capabilitiesUsed: SessionUsageCapability[] = [...runs]
    .map(([skillId, r]) => ({
      skillId,
      name: skillName.get(skillId) ?? r.verb ?? skillId,
      verb: r.verb,
      count: r.count,
      lastUsedAt: r.lastUsedAt,
    }))
    .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());

  const recordedEdges = edgeRows.filter(
    (e): e is typeof e & { toType: SessionPartKind } =>
      e.linkType === "used" &&
      (PART_KINDS as readonly string[]).includes(e.toType)
  );
  const grantEdges = edgeRows.filter(
    (e): e is typeof e & { toType: SessionGrantKind } =>
      e.linkType === "grants" &&
      (GRANT_KINDS as readonly string[]).includes(e.toType)
  );

  const [connectors, names] = await Promise.all([
    deriveConnectors(userId, skillRows, runs),
    resolvePartNames(
      userId,
      [...recordedEdges, ...grantEdges].map((e) => ({
        kind: e.toType,
        id: e.toId,
      }))
    ),
  ]);

  return {
    sessionId,
    capabilities: capabilitiesUsed,
    connectors,
    recorded: recordedEdges.map((e) => ({
      kind: e.toType,
      id: e.toId,
      name: names.get(`${e.toType}:${e.toId}`) ?? null,
      firstUsedAt: e.createdAt,
    })),
    granted: grantEdges.map((e) => ({
      kind: e.toType,
      id: e.toId,
      name: names.get(`${e.toType}:${e.toId}`) ?? null,
      grantedAt: e.createdAt,
    })),
    playbook,
    agents: staffed.participants,
  };
}
