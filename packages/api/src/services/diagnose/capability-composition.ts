/**
 * CAPABILITY-COMPOSITION builder — "what did this installed capability
 * materialize, and is it healthy?".
 *
 * Reuses existing primitives, invents no new store:
 *   · members  — `getLinksFor(capability)`, the `member_of` graph (complete with
 *                playbook/automation after the T5 wiring);
 *   · wired    — per-member: a skill needs its `requires --> tool` edge (an
 *                orphaned verb has none — the exact T4 bug); a playbook/automation
 *                must not be archived; a dangling link resolves to no row;
 *   · health   — `listRuns` per materialized playbook/automation flow, rolled up
 *                to failed / stuck / lastRunAt;
 *   · gaps     — the human-readable list of what is unwired.
 *
 * Returns the FROZEN `CapabilityComposition` shape (types.ts) verbatim.
 */

import {
  db,
  and,
  eq,
  or,
  isNull,
  desc,
  inArray,
  capabilities,
  tools,
  skills,
  playbooks,
  automations,
  links,
} from "@synap/database";
import { getLinksFor } from "../links/links-service.js";
import { listRuns } from "../runs/index.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { createLogger } from "@synap-core/core";
import {
  DEFAULT_STUCK_THRESHOLD_HOURS,
  type CapabilityComposition,
} from "./types.js";

const logger = createLogger({ module: "capability-composition" });

type MemberKind = "tool" | "skill" | "playbook" | "automation";
const MEMBER_KINDS: readonly MemberKind[] = [
  "tool",
  "skill",
  "playbook",
  "automation",
];

/** The already-loaded capability row (diagnose selects it before calling here). */
export interface CapabilityCompositionInput {
  userId: string;
  capability: {
    id: string;
    name: string;
    approved: boolean;
    metadata: Record<string, unknown> | null;
  };
}

export async function buildCapabilityComposition(
  input: CapabilityCompositionInput
): Promise<CapabilityComposition> {
  const { userId } = input;
  const cap = input.capability;

  // ── Members: the `member_of` graph pointing AT this capability. ────────────
  const allLinks = await getLinksFor(userId, "capability", cap.id);
  const memberLinks = allLinks.filter(
    (l) =>
      l.toType === "capability" &&
      l.toId === cap.id &&
      l.linkType === "member_of" &&
      (MEMBER_KINDS as readonly string[]).includes(l.fromType)
  );

  const idsByKind: Record<MemberKind, string[]> = {
    tool: [],
    skill: [],
    playbook: [],
    automation: [],
  };
  for (const l of memberLinks) {
    idsByKind[l.fromType as MemberKind].push(l.fromId);
  }

  // Resolve names (+ the per-kind wiring signal) in one batched read per kind.
  const toolNames = await loadNames(tools, idsByKind.tool);
  const skillNames = await loadNames(skills, idsByKind.skill);
  const playbookRows = await loadStatusRows(playbooks, idsByKind.playbook);
  const automationRows = await loadStatusRows(
    automations,
    idsByKind.automation
  );

  // A skill is WIRED iff it carries a `skill --requires--> tool` edge (the T4
  // orphaned-verb signal). Batched: one read over every skill member.
  const wiredSkillIds = new Set<string>();
  if (idsByKind.skill.length > 0) {
    const requiresRows = await db
      .select({ fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "skill"),
          inArray(links.fromId, idsByKind.skill),
          eq(links.linkType, "requires"),
          eq(links.toType, "tool")
        )
      );
    for (const r of requiresRows) wiredSkillIds.add(r.fromId);
  }

  const members: CapabilityComposition["members"] = [];
  const gaps: string[] = [];

  for (const id of idsByKind.tool) {
    const name = toolNames.get(id) ?? id.slice(0, 8);
    if (!toolNames.has(id)) gaps.push(`Tool member ${id} not found`);
    // A tool is the parent brick — it is self-standing (its own connection/
    // credential gate is separate), so a resolved tool member is always wired.
    members.push({ kind: "tool", id, name, wired: toolNames.has(id) });
  }
  for (const id of idsByKind.skill) {
    const name = skillNames.get(id) ?? id.slice(0, 8);
    const wired = skillNames.has(id) && wiredSkillIds.has(id);
    members.push({ kind: "skill", id, name, wired });
    if (!skillNames.has(id)) gaps.push(`Verb member ${id} not found`);
    else if (!wired) gaps.push(`Verb "${name}" has no parent tool (unwired)`);
  }
  for (const id of idsByKind.playbook) {
    const row = playbookRows.get(id);
    const name = row?.name ?? id.slice(0, 8);
    const wired = !!row && row.status !== "archived";
    members.push({ kind: "playbook", id, name, wired });
    if (!row) gaps.push(`Playbook member ${id} not found`);
    else if (!wired) gaps.push(`Playbook "${name}" is archived (unwired)`);
  }
  for (const id of idsByKind.automation) {
    const row = automationRows.get(id);
    const name = row?.name ?? id.slice(0, 8);
    const wired = !!row && row.status !== "archived";
    members.push({ kind: "automation", id, name, wired });
    if (!row) gaps.push(`Automation member ${id} not found`);
    else if (!wired) gaps.push(`Automation "${name}" is archived (unwired)`);
  }

  // ── Health: roll up runs over the materialized playbook/automation flows. ──
  const health = await rollUpHealth(userId, {
    playbookIds: idsByKind.playbook,
    automationIds: idsByKind.automation,
  });

  // ── Provenance: the template lineage stamped on the container (W1). ────────
  const meta = cap.metadata ?? {};
  const templateKey =
    typeof meta.templateKey === "string" ? meta.templateKey : undefined;
  const contentHash =
    typeof meta.contentHash === "string" ? meta.contentHash : undefined;
  const provenance =
    templateKey || contentHash
      ? {
          ...(templateKey ? { templateKey } : {}),
          ...(contentHash ? { contentHash } : {}),
        }
      : null;

  return {
    id: cap.id,
    name: cap.name,
    approved: cap.approved,
    provenance,
    members,
    health,
    gaps,
  };
}

/**
 * LIST mode — the whole-pod composition map (`capabilities.compositions` tRPC
 * door). Loads every capability CONTAINER visible to the caller (same lens as
 * `capabilities.containers.list`: user-visible floor + optional workspace
 * narrow, pod-wide NULL rows always included), then composes each. One element
 * per container; `.id` IS the container id (joins 1:1 to the atlas node). A
 * per-container composition failure degrades to omission, never a 500.
 */
export async function listCapabilityCompositions(args: {
  userId: string;
  workspaceId?: string | null;
}): Promise<CapabilityComposition[]> {
  const { userId, workspaceId } = args;
  const lens = workspaceId
    ? or(
        isNull(capabilities.workspaceId),
        eq(capabilities.workspaceId, workspaceId)
      )
    : undefined;
  const rows = await db
    .select({
      id: capabilities.id,
      name: capabilities.name,
      approved: capabilities.approved,
      metadata: capabilities.metadata,
    })
    .from(capabilities)
    .where(and(lens, userVisibleWhere(capabilities.workspaceId, userId)))
    .orderBy(desc(capabilities.createdAt));

  // Fan the per-container builds out in parallel. Each buildCapabilityComposition
  // does ~6 independent reads plus a per-flow listRuns; this list backs a Studio
  // surface polled ~every 15s, so a sequential for…await serialized ~120 DB
  // round-trips per call. Promise.all preserves input order (createdAt DESC).
  //
  // Per-container isolation is preserved AND now real: buildCapabilityComposition
  // can throw (a dangling link, a read error), and a bare Promise.all would reject
  // the whole batch on one bad row. Catching per-row degrades that container to
  // omission — the contract this function's doc already promises — instead of a 500.
  // TODO(perf): rollUpHealth still issues N listRuns per container; listRunGroups
  // groups by flowId in-DB and would collapse that to one grouped read per call.
  const built = await Promise.all(
    rows.map(async (row) => {
      try {
        return await buildCapabilityComposition({
          userId,
          capability: {
            id: row.id,
            name: row.name,
            approved: row.approved,
            metadata: row.metadata as Record<string, unknown> | null,
          },
        });
      } catch (err) {
        logger.warn(
          { capabilityId: row.id, err },
          "listCapabilityCompositions: skipped a container that failed to compose"
        );
        return null;
      }
    })
  );
  return built.filter((c): c is CapabilityComposition => c !== null);
}

/** id → name, batched. */
async function loadNames(
  table: typeof tools | typeof skills,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(inArray(table.id, ids));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

/** id → { name, status }, batched (playbooks / automations both have both). */
async function loadStatusRows(
  table: typeof playbooks | typeof automations,
  ids: string[]
): Promise<Map<string, { name: string; status: string }>> {
  const out = new Map<string, { name: string; status: string }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: table.id, name: table.name, status: table.status })
    .from(table)
    .where(inArray(table.id, ids));
  for (const r of rows) out.set(r.id, { name: r.name, status: r.status });
  return out;
}

/**
 * Aggregate run health across a capability's materialized flows. Reuses the ONE
 * runs substrate (`listRuns`) per flow so the numbers match the runs feed. Status
 * ladder: any failed → failed; else any stuck → degraded; else runs exist → ok;
 * no flows or no runs → unknown.
 */
async function rollUpHealth(
  userId: string,
  flows: { playbookIds: string[]; automationIds: string[] }
): Promise<CapabilityComposition["health"]> {
  const specs: Array<{ flowType: "playbook" | "automation"; flowId: string }> =
    [
      ...flows.playbookIds.map((flowId) => ({
        flowType: "playbook" as const,
        flowId,
      })),
      ...flows.automationIds.map((flowId) => ({
        flowType: "automation" as const,
        flowId,
      })),
    ];

  if (specs.length === 0) {
    return { status: "unknown", failedRuns: 0, stuckRuns: 0 };
  }

  const stuckBefore =
    Date.now() - DEFAULT_STUCK_THRESHOLD_HOURS * 60 * 60 * 1000;
  let failedRuns = 0;
  let stuckRuns = 0;
  let lastRunAt: Date | null = null;
  let sawAnyRun = false;

  for (const spec of specs) {
    const runs = await listRuns({
      userId,
      flowType: spec.flowType,
      flowId: spec.flowId,
      limit: 100,
    });
    for (const r of runs) {
      sawAnyRun = true;
      if (r.status === "failed") failedRuns += 1;
      if (r.status === "running" && r.startedAt.getTime() < stuckBefore) {
        stuckRuns += 1;
      }
      if (!lastRunAt || r.startedAt.getTime() > lastRunAt.getTime()) {
        lastRunAt = r.startedAt;
      }
    }
  }

  const status: CapabilityComposition["health"]["status"] = !sawAnyRun
    ? "unknown"
    : failedRuns > 0
      ? "failed"
      : stuckRuns > 0
        ? "degraded"
        : "ok";

  return {
    status,
    failedRuns,
    stuckRuns,
    ...(lastRunAt ? { lastRunAt: lastRunAt.toISOString() } : {}),
  };
}
