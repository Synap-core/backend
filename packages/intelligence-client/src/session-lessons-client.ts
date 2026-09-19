/**
 * Backend → IS stage-lesson revision (`POST /api/revise-lessons`,
 * synap-intelligence-service routes/session-intelligence/lessons.ts).
 *
 * Rides the shared session-intelligence transport (`postSessionIntelligence`:
 * per-call `{ serviceUrl, apiKey }`, a `generation` budget, ATTRIBUTED
 * failures). It THROWS on failure like its siblings, and the caller — the
 * weekly lessons scanner — MUST treat a throw as "skip this playbook", never
 * as "no lessons": filing a `playbook/update` proposal whose `lessons` were not
 * reconciled by the IS would write un-reviewed guidance into a stage.
 *
 * The answer is the FULL replacement list, never a delta. The pod still passes
 * it through `readStageLessons` (@synap/playbooks) before proposing anything —
 * the IS's own `sanitizeLessons` is the first bound, not the only one.
 */

import { postSessionIntelligence } from "./session-intelligence-client.js";

/** One thing recent runs of a stage got wrong — the evidence a revision answers. */
export interface StageLessonFinding {
  /** The criterion statement that failed, or that a person overrode. */
  statement: string;
  /** `failed` = the check failed; `overridden` = a person disagreed with the judge. */
  kind: "failed" | "overridden";
  /** In how many of the scanned sessions it happened. */
  occurrences: number;
  /** The overriding person's own words, when there are any. */
  rationale?: string;
}

/** Body of `POST /api/revise-lessons`. */
export interface ReviseLessonsRequest {
  playbookName?: string;
  stage: { name: string; goal?: string };
  /** What the stage already teaches. Empty on the first revision. */
  existingLessons: string[];
  findings: StageLessonFinding[];
}

/** Mirror of the IS `ReviseLessonsResult`. `lessons` is the FULL new list. */
export interface ReviseLessonsResult {
  lessons: string[];
  decider: "llm";
  model?: string;
}

export async function requestRevisedLessons(
  serviceUrl: string,
  serviceApiKey: string,
  payload: ReviseLessonsRequest
): Promise<ReviseLessonsResult> {
  return postSessionIntelligence<ReviseLessonsResult>(
    serviceUrl,
    serviceApiKey,
    "/api/revise-lessons",
    payload
  );
}
