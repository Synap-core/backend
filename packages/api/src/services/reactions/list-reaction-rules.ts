/**
 * THE ONE READ of the rules the reactions reactor applies (reactions W2/W3):
 * each built-in or declared rule with its id, its plain-words title, WHEN /
 * VIA / DO in words, whether it is on, who owns it (its rule row in the
 * pod's rule list, `reaction-rules-compile.ts`), and what it did lately (its
 * log, `listReactionOutcomes`, owner-floored). The person's "Rules" list
 * (decision D8: one list, the word "Rules") draws it beside the rules the
 * automation matcher runs; `statusOf` include "reactions" reads it per thing.
 */
import {
  and,
  db,
  inArray,
  listReactionOutcomes,
  skills,
  users,
  type ReactionLogRow,
} from "@synap/database";
import {
  listReactions,
  type ReactionDeclaration,
} from "@synap/jobs/utils/reactions.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { readReactionRuleRows } from "./reaction-rule-rows.js";

export interface ReactionRuleView {
  id: string;
  title: string;
  /** WHEN / VIA / DO, as the person reads them. */
  when: string;
  via: string;
  do: string;
  enabled: boolean;
  source: ReactionDeclaration["source"];
  /** Its moves fire other rules. */
  chains: boolean;
  /** A move into done or lost: proposed (the default, D3) or applied. */
  terminal: "propose" | "apply";
  terminalWhy: string | null;
  /**
   * Its row in the pod's rule list (where its pause lives); null until the
   * compile pass seeded it (it then keeps its declared default).
   */
  ruleId: string | null;
  /** Who owns it: the rule row's owner, by name when the pod knows one. */
  owner: { userId: string; name: string | null } | null;
  /** What it did lately, newest first (applied, proposed, skipped + why). */
  recent: ReactionLogRow[];
  /** The declaration itself, for a surface that edits it. */
  declaration: ReactionDeclaration;
}

const SUBJECT_WORDS: Record<string, string> = {
  entity: "A thing",
  track: "A goal",
  focus_session: "A session",
  playbook_run: "A run",
  proposal: "A proposal",
  slot: "An outcome",
};

const article = (noun: string) =>
  /^[aeiou]/i.test(noun) ? `An ${noun}` : `A ${noun}`;

/** The end of a declared relation that moves (the parent), in words. */
function parentEnd(r: ReactionDeclaration) {
  if (r.via.link !== "relation" || !r.declaredOn) return null;
  return r.via.parent === "target" ? r.declaredOn.target : r.declaredOn.source;
}

/** WHEN, in words. Pure. */
export function reactionWhenWords(r: ReactionDeclaration): string {
  const child =
    r.declaredOn && r.via.link === "relation"
      ? r.via.parent === "target"
        ? r.declaredOn.source
        : r.declaredOn.target
      : null;
  const subject = child
    ? article(child.name.toLowerCase())
    : (SUBJECT_WORDS[r.when.subjectType] ?? r.when.subjectType);
  const to = [...(r.when.to ?? []), ...(r.when.category ?? [])].map((s) =>
    s.replace(/_/g, " ")
  );
  return to.length > 0
    ? `${subject} moves to ${to.join(" or ")}`
    : `${subject} moves`;
}

/** VIA, in words. Pure. */
export function reactionViaWords(r: ReactionDeclaration): string {
  switch (r.via.link) {
    case "outcome_ref":
      return "every outcome, in any of your sessions, that points at what it approved";
    case "run_session":
      return "the session the run drives";
    case "slot_stage":
      return "the stage that owes the outcome, once every outcome it owes is in, and that session's thing";
    case "relation": {
      const parent = parentEnd(r)?.name.toLowerCase() ?? "thing";
      const rel = (r.declaredOn?.relationName ?? r.via.relation).toLowerCase();
      return r.via.parent === "target"
        ? `the ${parent} it is ${rel}`
        : `the ${parent} that it is linked to by "${rel}"`;
    }
  }
}

/** DO, in words. Pure. */
export function reactionDoWords(r: ReactionDeclaration): string {
  switch (r.do.effect) {
    case "meet_outcomes":
      return "is met";
    case "pause_session":
      return "pauses and waits on you until you answer";
    case "reach_stage_status":
      return "moves to the status that stage reaches when its work is approved";
    case "roll_up": {
      const to = r.do.to
        ? `moves to ${r.do.to.replace(/_/g, " ")}`
        : "moves to its next status";
      return `${to} once every part is done (a dropped part does not count)`;
    }
  }
}

export async function listReactionRules(input: {
  userId: string;
  /** Log rows per rule (default 5, at most 50). */
  recent?: number;
  /** Only these rules (by reaction id). */
  ids?: readonly string[];
}): Promise<ReactionRuleView[]> {
  const all = await listReactions();
  const asked = input.ids ? new Set(input.ids) : null;
  const rows = await readReactionRuleRows();
  // A rule row the reader may not see (a declared rule in a space they are
  // not in) hides its rule; a built-in rule is the pod's and always listed.
  const visible = rows.length
    ? new Set(
        (
          await db
            .select({ id: skills.id })
            .from(skills)
            .where(
              and(
                inArray(
                  skills.id,
                  rows.map((r) => r.id)
                ),
                visibleSkillsWhere(input.userId, undefined)
              )
            )
        ).map((r) => r.id)
      )
    : new Set<string>();
  const rowOf = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const id = row.meta.reaction!.id;
    const kept = rowOf.get(id);
    // One row per rule: a live one over a draft (the compile pass retires
    // any other).
    if (!kept || (kept.meta.draft && !row.meta.draft)) rowOf.set(id, row);
  }
  const rules = all.filter((r) => {
    if (asked && !asked.has(r.id)) return false;
    const row = rowOf.get(r.id);
    return r.source === "built_in" || !row || visible.has(row.id);
  });
  const ownerIds = [
    ...new Set(
      rules.map((r) => rowOf.get(r.id)?.userId).filter((u): u is string => !!u)
    ),
  ];
  const names = new Map(
    ownerIds.length
      ? (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, ownerIds))
        ).map((u) => [u.id, u.name ?? null])
      : []
  );
  const per = Math.min(Math.max(input.recent ?? 5, 0), 50);
  const log =
    per > 0 && rules.length > 0
      ? await listReactionOutcomes(db, {
          userId: input.userId,
          reactionIds: rules.map((r) => r.id),
          limit: Math.min(per * rules.length, 200),
        })
      : [];
  return rules.map((r) => {
    const row = rowOf.get(r.id);
    return {
      id: r.id,
      title: r.title,
      when: reactionWhenWords(r),
      via: reactionViaWords(r),
      do: reactionDoWords(r),
      enabled: r.enabled,
      source: r.source,
      chains: r.chains === true,
      terminal: r.terminal ?? "propose",
      terminalWhy: r.terminalWhy ?? null,
      ruleId: row?.id ?? null,
      owner: row
        ? { userId: row.userId, name: names.get(row.userId) ?? null }
        : null,
      recent: log.filter((l) => l.reactionId === r.id).slice(0, per),
      declaration: r,
    };
  });
}
