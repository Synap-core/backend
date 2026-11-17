/**
 * `statusOf` include "reactions" (plan 7d71ddcc W3): the RULES around one
 * subject, in the person's words. Two kinds, from THE one list of rules
 * (`listReactionRules`: built-in and declared, its floor, its pause):
 *   fires  a rule whose WHEN this subject's moves match (a run reaching
 *          "waiting on you"; a post reaching done, for its campaign's roll-up);
 *   moves  a rule whose effect moves THIS subject when what it is linked to
 *          moves (a campaign, rolled up by its posts; a session, paused by
 *          its run).
 * Each carries what it last did that touched this subject (its log,
 * owner-floored, `listReactionOutcomes` by subject) and, for a roll-up that
 * moves it, where its parts stand — "3 of 5 done" — read by THE parts reader
 * (`readPartsRollups`), floored to the parts the reader may see.
 */
import { db, inArray, listReactionOutcomes, profiles } from "@synap/database";
import type { TransitionSubjectType } from "@synap-core/types/lifecycle";
import { rollupProgressLabel } from "@synap-core/types/relations";
import type {
  StatusOfAnswerType,
  StatusOfReaction,
  StatusOfReactionOutcome,
} from "@synap-core/types/units";
import type { ReactionDeclaration } from "@synap/jobs/utils/reactions.js";
import {
  listReactionRules,
  type ReactionRuleView,
} from "../reactions/list-reaction-rules.js";
import { readPartsRollups } from "./status-rollup.js";

/** What one asked subject is, as the rules see it. */
export interface ReactionSubject {
  id: string;
  type: StatusOfAnswerType;
  /** A thing: its kind's slug and profile id (what a declared rule names). */
  profileSlug?: string | null;
  profileId?: string | null;
}

const SUBJECT_TYPE: Record<StatusOfAnswerType, TransitionSubjectType> = {
  entity: "entity",
  goal: "track",
  session: "focus_session",
  run: "playbook_run",
};

/** The subject type each effect MOVES (its target's door). */
const EFFECT_TARGET: Record<
  ReactionDeclaration["do"]["effect"],
  TransitionSubjectType
> = {
  meet_outcomes: "slot",
  pause_session: "focus_session",
  roll_up: "entity",
};

/** Does this rule fire when this subject moves? Pure. */
export function ruleFiresOn(
  r: ReactionDeclaration,
  s: ReactionSubject
): boolean {
  if (r.when.subjectType !== SUBJECT_TYPE[s.type]) return false;
  const kinds = r.when.profileSlug;
  return !kinds?.length || (!!s.profileSlug && kinds.includes(s.profileSlug));
}

/** Does this rule move this subject (when what it is linked to moves)? Pure. */
export function ruleMoves(r: ReactionDeclaration, s: ReactionSubject): boolean {
  if (EFFECT_TARGET[r.do.effect] !== SUBJECT_TYPE[s.type]) return false;
  if (r.via.link === "relation") {
    const parentProfile =
      r.via.parent === "target" ? r.via.targetProfileId : r.via.sourceProfileId;
    return !!s.profileId && s.profileId === parentProfile;
  }
  return true;
}

function sourceOf(r: ReactionDeclaration): StatusOfReaction["source"] {
  if (r.source === "built_in") return "default";
  return r.via.link === "relation" ? "relation" : "user";
}

function whenOf(r: ReactionDeclaration): StatusOfReaction["when"] {
  return {
    ...(r.when.to?.[0] ? { to: r.when.to[0] } : {}),
    ...(r.when.category?.[0] ? { category: r.when.category[0] } : {}),
  };
}

function entryOf(
  view: ReactionRuleView,
  role: StatusOfReaction["role"],
  last: StatusOfReactionOutcome | null
): StatusOfReaction {
  return {
    ruleId: view.id,
    ruleRowId: view.ruleId,
    name: view.title,
    source: sourceOf(view.declaration),
    role,
    when: whenOf(view.declaration),
    whenWords: view.when,
    via: view.via,
    does: view.do,
    paused: !view.enabled,
    terminal: view.terminal,
    last,
  };
}

/**
 * The rules around each subject, keyed by its id. One read of the rule list
 * for the whole call; one log read and at most one parts read per subject
 * that has a rule (`statusOf` asks about at most 10).
 */
export async function readStatusReactions(
  userId: string,
  subjects: readonly ReactionSubject[]
): Promise<Map<string, StatusOfReaction[]>> {
  const out = new Map<string, StatusOfReaction[]>();
  if (subjects.length === 0) return out;
  const views = await listReactionRules({ userId, recent: 0 });
  // A thing's kind slug (what a declared rule's WHEN names), one read.
  const profileIds = [
    ...new Set(
      subjects
        .filter((s) => s.profileId && !s.profileSlug)
        .map((s) => s.profileId!)
    ),
  ];
  const slugOf = new Map(
    profileIds.length
      ? (
          await db
            .select({ id: profiles.id, slug: profiles.slug })
            .from(profiles)
            .where(inArray(profiles.id, profileIds))
        ).map((p) => [p.id, p.slug])
      : []
  );
  await Promise.all(
    subjects.map(async (asked) => {
      const s: ReactionSubject = {
        ...asked,
        profileSlug:
          asked.profileSlug ??
          (asked.profileId ? (slugOf.get(asked.profileId) ?? null) : null),
      };
      const fires = views.filter((v) => ruleFiresOn(v.declaration, s));
      const moves = views.filter((v) => ruleMoves(v.declaration, s));
      if (fires.length === 0 && moves.length === 0) {
        out.set(s.id, []);
        return;
      }
      const log = await listReactionOutcomes(db, {
        userId,
        reactionIds: [...fires, ...moves].map((v) => v.id),
        subject: `${SUBJECT_TYPE[s.type]}:${s.id}`,
        limit: 50,
      });
      const lastOf = (id: string): StatusOfReactionOutcome | null => {
        const row = log.find((l) => l.reactionId === id);
        return row
          ? {
              outcome: row.outcome,
              code: row.code,
              reason: row.reason,
              at: row.at,
              proposalId: row.proposalId ?? null,
            }
          : null;
      };
      const entries: StatusOfReaction[] = [
        ...moves.map((v) => entryOf(v, "moves", lastOf(v.id))),
        ...fires.map((v) => entryOf(v, "fires", lastOf(v.id))),
      ];
      // "3 of 5 done" beside each roll-up that moves it.
      for (const e of entries) {
        const v = views.find((x) => x.id === e.ruleId)!;
        const via = v.declaration.via;
        if (e.role !== "moves" || via.link !== "relation") continue;
        const parts = await readPartsRollups({
          parentIds: [s.id],
          relation: via.relation,
          parentEnd: via.parent,
          viewer: userId,
        });
        const p = parts.get(s.id)?.progress;
        if (p) e.progress = { ...p, label: rollupProgressLabel(p) };
      }
      out.set(s.id, entries);
    })
  );
  return out;
}
