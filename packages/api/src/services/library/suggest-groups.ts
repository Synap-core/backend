/**
 * GROUP SUGGESTIONS — a new item joins an existing group as a SUGGESTION
 * (guardrail 4: stable structure, nothing re-clusters on arrival).
 *
 * After the light read (or a title-only arrival) the item is matched against
 * the person's existing `library_groups` — their name, note and the titles of
 * their recent members. Deterministic token overlap first; the AI's picks
 * (only when the read's one AI call ran anyway, inside the same call) are
 * merged after. The top 0–2 are written to
 * `documents.metadata.importCuration.suggestedGroupIds`.
 *
 * NEVER membership: the person accepts (`suggestion.accept`) or dismisses
 * (`suggestion.dismiss`). A dismissed group is never suggested again, a group
 * the item is already in is never suggested, and an archived group is never a
 * candidate. Groups are lensed: a group of another space is not suggested for
 * an item of this one (pod-wide groups and pod-wide items see every group).
 */

import {
  documents,
  libraryGroups,
  drizzleSql,
  and,
  desc,
  eq,
  isNull,
} from "@synap/database";
import type { db as DbType } from "@synap/database";

/** Suggestions written per item. */
export const GROUP_SUGGESTIONS_MAX = 2;
/** Groups considered per person (most recently touched first). */
export const GROUP_CANDIDATES_MAX = 40;
/** Member titles read per group. */
export const GROUP_MEMBER_TITLES = 12;
/** Score a group needs before it is suggested. */
export const GROUP_SUGGEST_MIN_SCORE = 3;

export interface GroupProfile {
  id: string;
  name: string;
  note?: string | null;
  memberTitles: string[];
}

const STOPWORDS = new Set(
  (
    "the and for with from that this your you are was were have has had not but " +
    "all any can will how what why who when where which into out about over more most " +
    "new one two our their its his her they them then than also just only very " +
    "les des une un est pour avec dans sur par pas plus que qui quoi aux ces son " +
    "ses mes tes nos vos leur leurs comment pourquoi http https www com html"
  ).split(" ")
);

/** Lowercase word stems of ≥ 3 letters, stopwords out, a plural `s` dropped. */
export function groupTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9]{3,}/g) ?? []
  )
    .filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

/**
 * Score each group for one item. A token of the group's NAME weighs 3, of its
 * NOTE 2, and a token shared with its members weighs 1 per member title that
 * carries it (at most 2). A group needs {@link GROUP_SUGGEST_MIN_SCORE}: one
 * name word, or a note word plus a member word, or the same words as several
 * members — never one shared common word.
 */
export function scoreGroupSuggestions(
  itemText: string,
  groups: readonly GroupProfile[]
): Array<{ groupId: string; score: number }> {
  const item = new Set(groupTokens(itemText));
  if (item.size === 0) return [];
  const out: Array<{ groupId: string; score: number }> = [];
  for (const g of groups) {
    const name = new Set(groupTokens(g.name));
    const note = new Set(groupTokens(g.note ?? ""));
    const members = new Map<string, number>();
    for (const title of g.memberTitles) {
      for (const t of new Set(groupTokens(title))) {
        members.set(t, (members.get(t) ?? 0) + 1);
      }
    }
    let score = 0;
    for (const t of item) {
      if (name.has(t)) score += 3;
      else if (note.has(t)) score += 2;
      score += Math.min(2, members.get(t) ?? 0);
    }
    if (score >= GROUP_SUGGEST_MIN_SCORE) out.push({ groupId: g.id, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The person's live groups the item may be suggested into, with member titles. */
export async function loadGroupProfiles(
  database: Pick<typeof DbType, "select">,
  args: { userId: string; workspaceId: string | null }
): Promise<GroupProfile[]> {
  const groups = await database
    .select({
      id: libraryGroups.id,
      name: libraryGroups.name,
      note: libraryGroups.note,
    })
    .from(libraryGroups)
    .where(
      and(
        eq(libraryGroups.userId, args.userId),
        isNull(libraryGroups.archivedAt),
        args.workspaceId
          ? drizzleSql`(${libraryGroups.workspaceId} IS NULL OR ${libraryGroups.workspaceId} = ${args.workspaceId})`
          : undefined
      )
    )
    .orderBy(desc(libraryGroups.updatedAt))
    .limit(GROUP_CANDIDATES_MAX);
  if (groups.length === 0) return [];
  const rows = await database
    .select({
      title: drizzleSql<string>`${documents.metadata} #>> '{importItem,title}'`,
      groupIds: drizzleSql<unknown>`${documents.metadata} -> 'importCuration' -> 'groupIds'`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        drizzleSql`${documents.deletedAt} IS NULL`,
        drizzleSql`${documents.metadata} ? 'importItem'`,
        drizzleSql`jsonb_array_length(COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb)) > 0`
      )
    )
    .orderBy(desc(documents.createdAt))
    .limit(GROUP_CANDIDATES_MAX * GROUP_MEMBER_TITLES);
  const titles = new Map<string, string[]>(groups.map((g) => [g.id, []]));
  for (const r of rows) {
    if (!r.title || !Array.isArray(r.groupIds)) continue;
    for (const id of r.groupIds) {
      const list = typeof id === "string" ? titles.get(id) : undefined;
      if (list && list.length < GROUP_MEMBER_TITLES) list.push(r.title);
    }
  }
  return groups.map((g) => ({ ...g, memberTitles: titles.get(g.id) ?? [] }));
}

/** Map the AI's picked group NAMES to ids (exact, case-insensitive). */
export function groupIdsFromNames(
  names: unknown,
  groups: readonly GroupProfile[]
): string[] {
  if (!Array.isArray(names)) return [];
  const byName = new Map(
    groups.map((g) => [g.name.trim().toLowerCase(), g.id])
  );
  const out: string[] = [];
  for (const n of names.slice(0, 5)) {
    const id =
      typeof n === "string" ? byName.get(n.trim().toLowerCase()) : undefined;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Write the suggestions (rule hits first, then the AI's), dropping groups the
 * item is in or the person dismissed. Under a row lock, so a curate edit made
 * meanwhile is never overwritten. Returns what was written.
 */
export async function writeGroupSuggestions(
  database: Pick<typeof DbType, "transaction">,
  args: { itemId: string; ruleIds: string[]; aiIds?: string[] }
): Promise<string[]> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: documents.metadata })
      .from(documents)
      .where(eq(documents.id, args.itemId))
      .for("update");
    if (!row) return [];
    const c = ((row.metadata as Record<string, unknown> | null)
      ?.importCuration ?? {}) as Record<string, unknown>;
    const list = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    const skip = new Set([...list(c.groupIds), ...list(c.dismissedGroupIds)]);
    const next: string[] = [];
    for (const id of [...args.ruleIds, ...(args.aiIds ?? [])]) {
      if (next.length >= GROUP_SUGGESTIONS_MAX) break;
      if (!skip.has(id) && !next.includes(id)) next.push(id);
    }
    const current = list(c.suggestedGroupIds);
    if (
      current.length === next.length &&
      current.every((id, i) => id === next[i])
    ) {
      return next;
    }
    await tx
      .update(documents)
      .set({
        metadata: drizzleSql`jsonb_set(jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importCuration}', coalesce(${documents.metadata} -> 'importCuration', '{}'::jsonb)), '{importCuration,suggestedGroupIds}', ${JSON.stringify(next)}::jsonb)`,
      })
      .where(eq(documents.id, args.itemId));
    return next;
  });
}
