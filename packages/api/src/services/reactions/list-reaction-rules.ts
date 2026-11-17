/**
 * THE ONE READ of the rules the reactions reactor applies (reactions W2,
 * visibility hook for lane E): each built-in or declared rule with its id,
 * its plain-words title, WHEN / VIA / DO in words, whether it is on, and
 * what it did lately (its log, `listReactionOutcomes`, owner-floored). Lane E
 * turns this into the person's "Rules" list (decision D8: one list, the word
 * "Rules"), beside the rules the automation matcher runs.
 */
import { db, listReactionOutcomes, type ReactionLogRow } from "@synap/database";
import {
  listReactions,
  type ReactionDeclaration,
} from "@synap/jobs/utils/reactions.js";

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

/** WHEN, in words. Pure. */
export function reactionWhenWords(r: ReactionDeclaration): string {
  const subject = SUBJECT_WORDS[r.when.subjectType] ?? r.when.subjectType;
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
  }
}

/** DO, in words. Pure. */
export function reactionDoWords(r: ReactionDeclaration): string {
  switch (r.do.effect) {
    case "meet_outcomes":
      return "is met";
    case "pause_session":
      return "pauses and waits on you until you answer";
  }
}

export async function listReactionRules(input: {
  userId: string;
  /** Log rows per rule (default 5, at most 50). */
  recent?: number;
}): Promise<ReactionRuleView[]> {
  const rules = await listReactions();
  const per = Math.min(Math.max(input.recent ?? 5, 0), 50);
  const log =
    per > 0
      ? await listReactionOutcomes(db, {
          userId: input.userId,
          reactionIds: rules.map((r) => r.id),
          limit: Math.min(per * rules.length, 200),
        })
      : [];
  return rules.map((r) => ({
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
    recent: log.filter((l) => l.reactionId === r.id).slice(0, per),
    declaration: r,
  }));
}
