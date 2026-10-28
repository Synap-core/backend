/**
 * Tools › Skills — every skill the reader can see, the ones waiting to be
 * turned on first. Pure shaping over `skills.list` rows; the tab draws it.
 *
 * Turning one on is `skills.setApproved` (`setSkillApproved`: a space's skill
 * needs that space's owner, a pod-wide one a pod admin; an agent key is always
 * refused). The page offers it only for an INSTRUCTION skill, drawn whole in
 * the confirmation (`turnOnRecords`, the record the turn-on request page
 * draws): its prose is everything it adds, and it runs nothing. A code or
 * declarative skill also has a reach the pod reads server-side
 * (`skillReach`), which this list does not carry; it is turned on where that
 * is shown: its capability's Actions tab, or the app.
 */

import type { ProposedRecord } from "../../../proposal/[id]/proposal-record-model";
import { turnOnRecords } from "../../../proposal/[id]/composite-parts-model";

/** The `skills.list` fields this tab reads (structural). */
export interface SkillListRow {
  id: string;
  name: string;
  slug?: string | null;
  kind: string;
  executionMode?: string | null;
  /** `pod` (everyone's) · `user` (one person's) · `workspace` (one space's). */
  scope?: string | null;
  workspaceId?: string | null;
  description?: string | null;
  body?: string | null;
  bodyDocumentId?: string | null;
  approved: boolean;
  createdAt: string | Date;
}

export interface SkillRow {
  id: string;
  name: string;
  /** The ref agents load it by (`rules/start-here`), when it has one. */
  slug: string | null;
  kind: string;
  /** Who it applies to, as the pod scopes it. */
  scope: "pod" | "user" | "workspace";
  workspaceId: string | null;
  createdAt: string;
  /** Instructions kept in a document instead of inline. */
  bodyDocumentId: string | null;
  /** How it is turned on, when it is off. */
  turnOn: "here" | "elsewhere" | null;
  /** The whole skill, as the confirmation draws it (instructions only). */
  record: ProposedRecord | null;
}

/** Shown before "Show all" in the On list. */
export const SKILLS_ON_SHOWN = 20;

function isoOf(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

export function skillRow(s: SkillListRow): SkillRow {
  const instruction = s.kind === "instruction";
  return {
    id: s.id,
    name: s.name,
    slug: s.slug?.trim() || null,
    kind: s.kind,
    scope:
      s.scope === "user" || s.scope === "workspace"
        ? s.scope
        : s.workspaceId
          ? "workspace"
          : "pod",
    workspaceId: s.workspaceId ?? null,
    createdAt: isoOf(s.createdAt),
    bodyDocumentId: s.bodyDocumentId ?? null,
    turnOn: s.approved ? null : instruction ? "here" : "elsewhere",
    record:
      instruction && !s.approved
        ? (turnOnRecords({
            skills: [
              {
                id: s.id,
                name: s.name,
                kind: s.kind,
                executionMode: s.executionMode ?? "sandbox",
                ...(s.body ? { body: s.body } : {}),
              },
            ],
            unreadSkills: 0,
          })[0] ?? null)
        : null,
  };
}

/**
 * The two lists: waiting first (oldest first: the longest wait is the first
 * question), then the skills already on (newest first, as the pod lists them).
 * A row in both reads (it moved between them) is drawn once, from its newest
 * state: the On read wins.
 */
export function skillLists(
  waiting: readonly SkillListRow[],
  on: readonly SkillListRow[]
): { waiting: SkillRow[]; on: SkillRow[] } {
  const onIds = new Set(on.map((s) => s.id));
  return {
    waiting: waiting
      .filter((s) => !onIds.has(s.id))
      .map(skillRow)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    on: on.map(skillRow),
  };
}
