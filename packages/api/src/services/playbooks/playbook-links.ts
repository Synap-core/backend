/**
 * PLAYBOOK LINKS — "when a run of X ends, start Y".
 *
 * A link is an ACTIVATOR declared on the playbook it starts (`on:
 * "run_ended"`, `playbook: <name or id>`, optional `outcome`), compiled like
 * every activator into a governed rule (`playbook-activators.ts`) on the
 * session close event, and linked in `playbook_automations` with role
 * `link`. No second engine.
 *
 *   - {@link resolveLinkedPlaybooks}: a declared ref → the playbook it names,
 *     in the declaring playbook's space or pod-wide, archived out. A catalog
 *     names a link by NAME; the compile resolves it, and the activator memory
 *     pins the id it compiled to.
 *   - {@link findPlaybookLinkCycle}: the write-time loop guard over links AND
 *     steps that `use` a playbook, in one walk. A loop that slips past it is
 *     stopped where a link starts a run (`@synap/jobs` `utils/link-lineage.ts`).
 *   - {@link readPlaybookLinksInto}: the live links into a playbook, for the
 *     flow read.
 */
import {
  and,
  asc,
  automations,
  db,
  drizzleSql,
  eq,
  inArray,
  isNull,
  ne,
  or,
  playbookAutomations,
  playbooks,
  type SQL,
} from "@synap/database";
import type { PlaybookActivator } from "@synap/playbooks";
import { isUuid } from "@synap-core/types/property-render";
import {
  WORKER_RUN_OUTCOMES,
  type WorkerRunOutcome,
} from "@synap-core/types/workers";
import { readPlaybookProcess } from "../../schemas/playbook-process.js";
import { LINK_ROLE } from "./playbook-automation-links.js";

/** The refs of a playbook's declared links, in order, each once. */
export function linkRefsOf(activators: readonly PlaybookActivator[]): string[] {
  const out: string[] = [];
  for (const a of activators) {
    const ref = a.on === "run_ended" ? a.playbook?.trim() : undefined;
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

interface PlaybookNode {
  id: string;
  name: string;
  workspaceId: string | null;
  subjectProfile: unknown;
  stages: unknown;
}

/** The playbooks a playbook in `workspaceId` may link to: its space and pod-wide, oldest first. */
async function linkablePlaybooks(
  workspaceId: string | null,
  only?: SQL
): Promise<PlaybookNode[]> {
  return db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      workspaceId: playbooks.workspaceId,
      subjectProfile: playbooks.subjectProfile,
      stages: playbooks.stages,
    })
    .from(playbooks)
    .where(
      and(
        ne(playbooks.status, "archived"),
        workspaceId
          ? or(
              isNull(playbooks.workspaceId),
              eq(playbooks.workspaceId, workspaceId)
            )
          : isNull(playbooks.workspaceId),
        only
      )
    )
    .orderBy(asc(playbooks.createdAt), asc(playbooks.id));
}

/**
 * The ONE name rule: an id names itself; a name matches case-insensitively,
 * the space's own playbook before a pod-wide one, then the oldest.
 */
function pick<T extends { id: string; name: string; workspaceId: string | null }>(
  ref: string,
  rows: readonly T[]
): T | undefined {
  const hits = isUuid(ref)
    ? rows.filter((r) => r.id === ref)
    : rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
  return hits.find((r) => r.workspaceId !== null) ?? hits[0];
}

/**
 * Each ref → the playbook it names, seen from a playbook in `workspaceId`
 * (null = pod-wide: only pod-wide playbooks). A ref that names nothing is
 * absent from the map.
 */
export async function resolveLinkedPlaybooks(
  refs: readonly string[],
  workspaceId: string | null
): Promise<Map<string, PlaybookNode>> {
  const out = new Map<string, PlaybookNode>();
  if (refs.length === 0) return out;
  const ids = refs.filter((r) => isUuid(r));
  const names = refs.filter((r) => !ids.includes(r)).map((r) => r.toLowerCase());
  const rows = await linkablePlaybooks(
    workspaceId,
    or(
      ids.length > 0 ? inArray(playbooks.id, ids) : undefined,
      names.length > 0
        ? inArray(drizzleSql<string>`lower(${playbooks.name})`, names)
        : undefined
    )
  );
  for (const ref of refs) {
    const hit = pick(ref, rows);
    if (hit) out.set(ref, hit);
  }
  return out;
}

/** The playbooks a playbook's stages `use` (their pinned ids). */
function usedBy(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages.flatMap((s) => {
    const id = (s as { uses?: { playbookId?: unknown } } | null)?.uses
      ?.playbookId;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * The loop the playbook being written would close, as names from it back to
 * itself (`["Ship", "Announce", "Ship"]`, each one starting the next), or
 * null. Two edges start a playbook: a link (`run_ended`: X's end starts Y)
 * and a step that `uses` one (X's step starts Y); a loop may mix them.
 *
 * `self` is the playbook as it will be stored. A ref equal to its id, or to
 * its name in any case, IS self even before it exists, so a create, a
 * rename, an install of two playbooks that follow each other and an
 * unarchive are judged the same way.
 */
export async function findPlaybookLinkCycle(self: {
  id: string | null;
  name: string;
  workspaceId: string | null;
  activators: readonly PlaybookActivator[];
  stages: unknown;
}): Promise<string[] | null> {
  const SELF = self.id ?? "\u0000self";
  const nodes: PlaybookNode[] = [
    {
      id: SELF,
      name: self.name.trim(),
      workspaceId: self.workspaceId,
      subjectProfile: { activators: self.activators },
      stages: self.stages,
    },
    ...(await linkablePlaybooks(self.workspaceId)).filter(
      (n) => n.id !== self.id
    ),
  ];
  // A node sees its own space and pod-wide ones; self is first, so a name
  // equal to self's (in its reach) resolves to self.
  const resolve = (ref: string, from: PlaybookNode) =>
    pick(
      ref,
      nodes.filter(
        (n) => n.workspaceId === null || n.workspaceId === from.workspaceId
      )
    )?.id ?? (ref === self.id ? SELF : undefined);
  const next = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const n of nodes) {
    for (const ref of linkRefsOf(
      readPlaybookProcess(n.subjectProfile).activators
    )) {
      const from = resolve(ref, n);
      if (from) next.get(from)?.add(n.id);
    }
    for (const used of usedBy(n.stages)) {
      const to = used === self.id ? SELF : used;
      if (next.has(to)) next.get(n.id)!.add(to);
    }
  }
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  const seen = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    for (const to of next.get(id) ?? []) {
      if (to === SELF) return [...path, name.get(SELF)!];
      if (seen.has(to)) continue;
      seen.add(to);
      const found = walk(to, [...path, name.get(to)!]);
      if (found) return found;
    }
    return null;
  };
  return walk(SELF, [name.get(SELF)!]);
}

/** The refusal of a loop, in the person's words. */
export function playbookLinkCycleMessage(path: readonly string[]): string {
  return `These playbooks start each other in a loop: ${path.join(" → ")} (a run's end or a step starts the next). Remove one link.`;
}

/** One live link, read off the rule it compiled to: "starts after X". */
export interface PlaybookLinkEdge {
  /** The playbook whose run ending starts this one. */
  playbookId: string;
  playbookName: string;
  /** null = any end. */
  outcome: WorkerRunOutcome | null;
}

/**
 * What a link's compiled rule says (`playbookActivatorSentence`): the
 * followed playbook on its `playbookId` filter, the outcome on its
 * `closedAs` filter. null for a trigger that is not a link's.
 */
export function linkOfTrigger(
  triggerConfig: unknown
): { playbookId: string; outcome: WorkerRunOutcome | null } | null {
  const filters = (triggerConfig as { filters?: Record<string, unknown> })
    ?.filters;
  const playbookId = filters?.playbookId;
  if (typeof playbookId !== "string" || !playbookId) return null;
  const closedAs = filters?.closedAs;
  const outcome =
    WORKER_RUN_OUTCOMES.find((o) => o === closedAs) ?? null;
  return { playbookId, outcome };
}

/**
 * The live links INTO each of `playbookIds`: its `link` rows in
 * `playbook_automations` whose automation is active, read through the
 * compiled trigger. A followed playbook the reader cannot see (`visible`) is
 * left out.
 */
export async function readPlaybookLinksInto(
  playbookIds: readonly string[],
  visible: SQL | undefined
): Promise<Map<string, PlaybookLinkEdge[]>> {
  const out = new Map<string, PlaybookLinkEdge[]>();
  if (playbookIds.length === 0) return out;
  const rows = await db
    .select({
      playbookId: playbookAutomations.playbookId,
      triggerConfig: automations.triggerConfig,
    })
    .from(playbookAutomations)
    .innerJoin(automations, eq(automations.id, playbookAutomations.automationId))
    .where(
      and(
        inArray(playbookAutomations.playbookId, [...playbookIds]),
        eq(playbookAutomations.role, LINK_ROLE),
        eq(automations.status, "active")
      )
    );
  const parsed = rows.flatMap((r) => {
    const link = linkOfTrigger(r.triggerConfig);
    return link ? [{ into: r.playbookId, ...link }] : [];
  });
  if (parsed.length === 0) return out;
  const names = new Map(
    (
      await db
        .select({ id: playbooks.id, name: playbooks.name })
        .from(playbooks)
        .where(
          and(
            visible,
            inArray(
              playbooks.id,
              parsed.map((p) => p.playbookId)
            )
          )
        )
    ).map((p) => [p.id, p.name])
  );
  for (const p of parsed) {
    const name = names.get(p.playbookId);
    if (name === undefined) continue;
    const list = out.get(p.into) ?? [];
    list.push({
      playbookId: p.playbookId,
      playbookName: name,
      outcome: p.outcome,
    });
    out.set(p.into, list);
  }
  return out;
}
