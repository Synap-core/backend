/**
 * TURNS ON — what a pending `capability.enable` would switch on, for its
 * review (`ProposalReviewModel.turnsOn`, founder 2026-10-28).
 *
 * The request carries only ids (`proposeCapabilityEnable`), so a person
 * approving it read a list of names and turned on code nobody showed them.
 * This reads each skill it names, whole: its kind, its code or prose, and its
 * reach through the one "Can reach" reader (`skillReach`, with the tools it
 * declares). Lens: the viewer's skill read rule in the proposal's workspace
 * (`visibleSkillsWhere`), the floor every other read of the review applies;
 * a skill the viewer cannot read is counted, never dropped silently.
 */

import { db, skills, and, or, inArray } from "@synap/database";
import type {
  ProposalTurnOnSkill,
  ProposalTurnsOn,
} from "@synap-core/types/proposals";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { readRequiredToolNames, skillReach } from "./part-reach.js";

/** The rows the review reads (a stored proposal row fits). */
export interface EnableRow {
  id: string;
  proposalType: string;
  workspaceId: string | null;
  data: unknown;
}

/** The skill ids a `capability.enable` turns on (`skillIds`, or the legacy `skillId`). */
export function enableSkillIds(data: unknown): string[] {
  const bag = (data ?? {}) as { skillIds?: unknown; skillId?: unknown };
  if (Array.isArray(bag.skillIds)) {
    return bag.skillIds.filter((id): id is string => typeof id === "string");
  }
  return typeof bag.skillId === "string" ? [bag.skillId] : [];
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Read, for every `capability.enable` among `rows` (pass only pending ones),
 * the skills it would turn on. One query for the skills, one for their
 * declared tools. A failed read throws: never "turns on nothing" for "could
 * not read".
 */
export async function readEnableTurnsOn(
  rows: readonly EnableRow[],
  userId: string
): Promise<Map<string, ProposalTurnsOn>> {
  const out = new Map<string, ProposalTurnsOn>();
  const enables = rows.filter((r) => r.proposalType === "capability.enable");
  if (enables.length === 0) return out;
  const ids = [...new Set(enables.flatMap((r) => enableSkillIds(r.data)))];
  const workspaceIds = [
    ...new Set(enables.flatMap((r) => (r.workspaceId ? [r.workspaceId] : []))),
  ];
  const found =
    ids.length === 0
      ? []
      : await db
          .select({
            id: skills.id,
            name: skills.name,
            kind: skills.kind,
            executionMode: skills.executionMode,
            code: skills.code,
            body: skills.body,
            providerSpec: skills.providerSpec,
            metadata: skills.metadata,
          })
          .from(skills)
          .where(
            and(
              inArray(skills.id, ids),
              or(
                visibleSkillsWhere(userId, undefined, {
                  includeExpired: true,
                }),
                ...workspaceIds.map((ws) =>
                  visibleSkillsWhere(userId, ws, { includeExpired: true })
                )
              )
            )
          );
  const required = await readRequiredToolNames(
    userId,
    found.map((s) => s.id)
  );
  const byId = new Map(found.map((s) => [s.id, s]));
  for (const row of enables) {
    const wanted = enableSkillIds(row.data);
    const read: ProposalTurnOnSkill[] = [];
    for (const id of wanted) {
      const s = byId.get(id);
      if (!s) continue;
      const metadata = (s.metadata ?? {}) as Record<string, unknown>;
      const isBox = s.executionMode === "box";
      const box =
        isBox && metadata.box && typeof metadata.box === "object"
          ? (metadata.box as Record<string, unknown>)
          : undefined;
      const reach = isBox
        ? null
        : skillReach({ ...s, requiredTools: required.get(s.id) });
      const code = nonBlank(s.code);
      const body = nonBlank(s.body);
      read.push({
        id: s.id,
        name: s.name,
        kind: s.kind,
        executionMode: s.executionMode,
        ...(code ? { code } : {}),
        ...(body ? { body } : {}),
        ...(box ? { box } : {}),
        ...(reach ? { reach } : {}),
      });
    }
    out.set(row.id, {
      skills: read,
      unreadSkills: wanted.length - read.length,
    });
  }
  return out;
}
