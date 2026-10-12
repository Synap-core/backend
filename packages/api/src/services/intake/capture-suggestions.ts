/**
 * Next steps for a capture, found BEFORE anything is filed (D6).
 *
 * `playbooks.matchForEntity` and `automations.matchForEntity` already work from
 * a kind + the note alone ("idea of content for synap" → Plan Next Content,
 * Produce Content), so the structure run asks them once and stores the ranked
 * result on the `capture_result` part. The thread shows them under the chips as
 * one-tap "start once filed"; filing then launches through the existing
 * next-step door. No second matcher: both doors keep their own ranking.
 */

import {
  CAPTURE_RESULT_LIMITS,
  type CaptureResultSuggestion,
} from "@synap-core/types/capture";

/** One candidate as either match door returns it. */
export interface MatchedNextStep {
  id: string;
  name: string;
  score?: number;
  reason?: string;
  /** Playbooks: the kind it runs on (`null` = needs no subject). */
  subjectProfileSlug?: string | null;
}

export interface CaptureSuggestionDoors {
  matchPlaybooks: (input: {
    profileSlug: string;
    workspaceId: string;
    intentText?: string;
  }) => Promise<MatchedNextStep[]>;
  matchRules: (input: {
    profileSlug: string;
    workspaceId: string;
    intentText?: string;
  }) => Promise<MatchedNextStep[]>;
}

/** Rows asked about (one match per distinct kind, best rows first). */
const KINDS_ASKED_MAX = 3;

/**
 * Merge both doors' answers for every asked row into one ranked list. PURE.
 * A step offered for several rows keeps its best score and its first row;
 * a playbook that needs no subject needs nothing filed (`forTempId: null`).
 */
export function mergeCaptureSuggestions(
  answers: ReadonlyArray<{
    tempId: string;
    playbooks: ReadonlyArray<MatchedNextStep>;
    rules: ReadonlyArray<MatchedNextStep>;
  }>
): CaptureResultSuggestion[] {
  const L = CAPTURE_RESULT_LIMITS;
  const best = new Map<
    string,
    { s: CaptureResultSuggestion; score: number; order: number }
  >();
  let order = 0;
  for (const answer of answers) {
    const take = (kind: "playbook" | "rule", m: MatchedNextStep) => {
      if (!m.id || !m.name?.trim()) return;
      const key = `${kind}:${m.id}`;
      const score = typeof m.score === "number" ? m.score : 0;
      const prior = best.get(key);
      if (prior && prior.score >= score) return;
      const reason = m.reason?.replace(/\s+/g, " ").trim();
      best.set(key, {
        s: {
          kind,
          id: m.id.slice(0, L.routingIdMaxChars),
          title: m.name.trim().slice(0, L.titleMaxChars),
          forTempId:
            prior?.s.forTempId !== undefined
              ? prior.s.forTempId
              : kind === "playbook" && m.subjectProfileSlug === null
                ? null
                : answer.tempId,
          ...(reason
            ? { reason: reason.slice(0, L.suggestionReasonMaxChars) }
            : {}),
        },
        score,
        order: prior?.order ?? order++,
      });
    };
    for (const m of answer.playbooks) take("playbook", m);
    for (const m of answer.rules) take("rule", m);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, L.suggestionsMax)
    .map(({ s }) => s);
}

/**
 * Ask both doors for the capture's open rows. THROWS when a door fails: the
 * caller then stores NO `suggestions` (absent = not computed), never `[]`,
 * which would read as "nothing to do".
 */
export async function findCaptureSuggestions(args: {
  rows: ReadonlyArray<{ tempId: string; profileSlug: string }>;
  workspaceId: string;
  intentText: string;
  doors: CaptureSuggestionDoors;
}): Promise<CaptureResultSuggestion[]> {
  const asked: Array<{ tempId: string; profileSlug: string }> = [];
  for (const row of args.rows) {
    if (asked.some((a) => a.profileSlug === row.profileSlug)) continue;
    asked.push(row);
    if (asked.length >= KINDS_ASKED_MAX) break;
  }
  const intentText = args.intentText.trim().slice(0, 2000) || undefined;
  const answers = await Promise.all(
    asked.map(async (row) => {
      const input = {
        profileSlug: row.profileSlug,
        workspaceId: args.workspaceId,
        ...(intentText ? { intentText } : {}),
      };
      const [playbooks, rules] = await Promise.all([
        args.doors.matchPlaybooks(input),
        args.doors.matchRules(input),
      ]);
      return { tempId: row.tempId, playbooks, rules };
    })
  );
  return mergeCaptureSuggestions(answers);
}
