/**
 * PLAYBOOK LINKS — "when a run of X ends, start Y" (work model D6 a).
 *
 * A link is an ACTIVATOR declared on the playbook it starts (`on:
 * "run_ended"`, `playbook: <name or id>`, optional `outcome`), compiled like
 * every activator into a governed rule (`playbook-activators.ts`) on the
 * session close event, and linked in `playbook_automations` with role
 * `link`. No second engine.
 *
 * This module holds the two reads a link needs:
 *   - {@link resolveLinkedPlaybooks}: a declared ref → the playbook it names,
 *     in the declaring playbook's space or pod-wide, archived out. A catalog
 *     playbook names its link by NAME (ids are minted on install), so an
 *     install resolves it here when the rule is compiled; a playbook the
 *     package installs later is picked up by the next pass (the reconcile
 *     re-converges activators on every boot).
 *   - {@link findPlaybookLinkCycle}: the write-time loop guard. A chain of
 *     links that comes back to the playbook being written is refused at the
 *     write door. At run time the automation matcher's chain guard
 *     (`MAX_CHAIN_DEPTH`, and a rule never fires twice in one chain) stops a
 *     loop that slipped through, e.g. one made later by a rename: the close
 *     event carries the session, whose stamped chain context the matcher
 *     re-derives.
 */
import {
  and,
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
import type { WorkerRunOutcome } from "@synap-core/types/workers";
import { readPlaybookProcess } from "../../schemas/playbook-process.js";
import { LINK_ROLE } from "./playbook-automation-links.js";

/** The refs of a playbook's declared links, in order, each once. */
export function linkRefsOf(
  activators: readonly PlaybookActivator[]
): string[] {
  const out: string[] = [];
  for (const a of activators) {
    const ref = a.on === "run_ended" ? a.playbook?.trim() : undefined;
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

interface LinkedPlaybook {
  id: string;
  name: string;
  workspaceId: string | null;
  subjectProfile: unknown;
}

/**
 * Each ref → the playbook it names, seen from a playbook in `workspaceId`
 * (null = pod-wide: only pod-wide playbooks). An id must be in that space or
 * pod-wide; a name matches case-insensitively, the space's own playbook
 * before a pod-wide one of the same name. A ref that names nothing is absent
 * from the map.
 */
export async function resolveLinkedPlaybooks(
  refs: readonly string[],
  workspaceId: string | null
): Promise<Map<string, LinkedPlaybook>> {
  const out = new Map<string, LinkedPlaybook>();
  if (refs.length === 0) return out;
  const ids = refs.filter((r) => isUuid(r));
  const names = refs.filter((r) => !isUuid(r)).map((r) => r.toLowerCase());
  const space = workspaceId
    ? or(isNull(playbooks.workspaceId), eq(playbooks.workspaceId, workspaceId))
    : isNull(playbooks.workspaceId);
  const rows = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      workspaceId: playbooks.workspaceId,
      subjectProfile: playbooks.subjectProfile,
    })
    .from(playbooks)
    .where(
      and(
        ne(playbooks.status, "archived"),
        space,
        or(
          ids.length > 0 ? inArray(playbooks.id, ids) : undefined,
          names.length > 0
            ? inArray(drizzleSql<string>`lower(${playbooks.name})`, names)
            : undefined
        )
      )
    );
  for (const ref of refs) {
    const hits = isUuid(ref)
      ? rows.filter((r) => r.id === ref)
      : rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
    const hit = hits.find((r) => r.workspaceId !== null) ?? hits[0];
    if (hit) out.set(ref, hit);
  }
  return out;
}

/** How many links deep the write-time walk looks before it stops. */
const LINK_WALK_MAX = 64;

/**
 * The loop a playbook's declared links would close, as playbook names from
 * the playbook being written back to itself (`["Ship", "Announce",
 * "Ship"]`); null when there is none. `self` is the playbook as it will be
 * stored: its id once it exists, its name and space (a create matches itself
 * by name in its space).
 */
export async function findPlaybookLinkCycle(self: {
  id: string | null;
  name: string;
  workspaceId: string | null;
  activators: readonly PlaybookActivator[];
}): Promise<string[] | null> {
  const isSelf = (p: LinkedPlaybook) =>
    (self.id !== null && p.id === self.id) ||
    (p.workspaceId === self.workspaceId &&
      p.name.toLowerCase() === self.name.trim().toLowerCase());
  // Each queued playbook with the path of names that reached it.
  let frontier: Array<{
    refs: string[];
    workspaceId: string | null;
    path: string[];
  }> = [
    {
      refs: linkRefsOf(self.activators),
      workspaceId: self.workspaceId,
      path: [self.name],
    },
  ];
  const seen = new Set<string>();
  for (let depth = 0; depth < LINK_WALK_MAX && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      const resolved = await resolveLinkedPlaybooks(
        node.refs,
        node.workspaceId
      );
      for (const p of resolved.values()) {
        if (isSelf(p)) return [...node.path, self.name];
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        next.push({
          refs: linkRefsOf(readPlaybookProcess(p.subjectProfile).activators),
          workspaceId: p.workspaceId,
          path: [...node.path, p.name],
        });
      }
    }
    frontier = next;
  }
  return null;
}

/** The refusal of a link loop, in the person's words. */
export function playbookLinkCycleMessage(path: readonly string[]): string {
  return `These links make a loop: ${path.join(" starts after ")}. A run ending would start the run that started it; remove one of the links.`;
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
 * What the compiled rule says (`playbookActivatorSentence`, `run_ended`): the
 * followed playbook on the trigger's `playbookId` filter, the outcome on its
 * `status` filter (`closed` = delivered, not `closed` = dropped). null for a
 * trigger that is not a link's.
 */
export function linkOfTrigger(
  triggerConfig: unknown
): { playbookId: string; outcome: WorkerRunOutcome | null } | null {
  const filters = (triggerConfig as { filters?: Record<string, unknown> })
    ?.filters;
  const playbookId = filters?.playbookId;
  if (typeof playbookId !== "string" || !playbookId) return null;
  const status = filters?.status;
  const outcome: WorkerRunOutcome | null =
    status === "closed"
      ? "delivered"
      : (status as { $ne?: unknown } | undefined)?.$ne === "closed"
        ? "dropped"
        : null;
  return { playbookId, outcome };
}

/**
 * The live links INTO each of `playbookIds` (the playbooks whose run end
 * starts it): its `link` rows in `playbook_automations` whose automation is
 * active, read through the compiled trigger. A followed playbook the reader
 * cannot see (`visible`, the playbook floor) is left out.
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
    list.push({ playbookId: p.playbookId, playbookName: name, outcome: p.outcome });
    out.set(p.into, list);
  }
  return out;
}
