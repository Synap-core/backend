/**
 * Playbook Lessons Scanner — turns a playbook's OWN run history into the
 * standing advice its stages give the next agent.
 *
 * Weekly, for every playbook whose closed runs have actually been graded: read
 * the scorecard, find the criteria that keep FAILING or that a person keeps
 * OVERRIDING the judge on, and ask the IS to rewrite the affected stages'
 * `lessons` — then file ONE `playbook/update` proposal per playbook. A human
 * approves it (or edits it first); the scanner never writes a playbook.
 *
 * ── RECONCILE, NEVER APPEND ─────────────────────────────────────────────────
 * The IS returns the FULL replacement list for a stage (existing lessons plus
 * what the new evidence teaches, contradictions replaced, near-duplicates
 * merged), and the proposal REPLACES `stages[].lessons` wholesale. This is the
 * whole point of the design: an append-only memory grows into a wall of stale,
 * mutually contradictory advice that the agent stops reading — the Letta /
 * MemGPT failure mode. The bound is enforced three times: by the IS route's
 * `sanitizeLessons`, by `readStageLessons` here, and by `playbookStageSchema`
 * at the write door on approval.
 *
 * ── ONE DERIVATION ──────────────────────────────────────────────────────────
 * The evidence comes from `utils/playbook-scorecard.ts` — the same projection
 * the tRPC `playbooks.scorecard` renders. No SQL is re-derived here. The
 * scanner calls `loadPlaybookScorecardRows` + `projectPlaybookScorecard`
 * (which IS the body of `computePlaybookScorecard`) rather than the wrapper
 * only because it also needs the row-level lineage — WHICH sessions the finding
 * came from, and the overriding person's own words — that the projected
 * scorecard summarises away.
 *
 * ── WHERE A LESSON LIVES ────────────────────────────────────────────────────
 * A criterion that belongs to a stage teaches that stage (`stages[].lessons`).
 * A PLAYBOOK-LEVEL criterion (no `stageKey`), and every criterion of a
 * playbook with no stages, teaches the playbook itself
 * (`metadata.lessons`, plan W8 D7a), never an arbitrary stage.
 *
 * ── WHAT WORKED ─────────────────────────────────────────────────────────────
 * The runs teach what to do as well as what went wrong (founder: "the
 * playbook is the inherent system coming from what others did"). From the
 * SUCCESSFUL runs (`successfulRunIds`: every required criterion passed), the
 * tools and skills they recorded using (`loadRunsUsedParts`, the
 * `session --used-->` edges) that at least `MIN_FINDING_OCCURRENCES` of them
 * used become `metadata.whatWorked`, replaced whole on every revision. It is
 * counted, not written by the IS. It rides in the same proposal; a person
 * approves it like the lessons.
 *
 * ── IS FAILURE IS A SKIP, NEVER A DEGRADED PROPOSAL ─────────────────────────
 * If any stage's revision call fails, the whole playbook is skipped and logged.
 * A proposal carrying un-reconciled content would ask a human to approve
 * guidance nothing wrote.
 *
 * Queue: playbook-lessons.scan
 * Cron:  weekly, Mondays 04:10 UTC (after the daily scanners at 3:50 / 3:55)
 */

import {
  db,
  and,
  eq,
  isNotNull,
  inArray,
  drizzleSql,
  focusSessions,
  playbooks,
  proposals,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import {
  MAX_WHAT_WORKED_PARTS,
  readCriteria,
  readPlaybookLessons,
  readStageLessons,
  readWhatWorked,
  type WhatWorked,
} from "@synap/playbooks";
import {
  getDefaultActiveService,
  requestRevisedLessons,
  type ReviseLessonsRequest,
  type StageLessonFinding,
} from "@synap/intelligence-client";
import {
  loadPlaybookScorecardRows,
  projectPlaybookScorecard,
  findOverrides,
  loadRunsUsedParts,
  successfulRunIds,
  type RunUsedPart,
  type PlaybookScorecard,
  type ScorecardEvaluationRow,
  type ScorecardSessionRow,
} from "../utils/playbook-scorecard.js";

const logger = createLogger({ module: "playbook-lessons-scanner" });

export const PLAYBOOK_LESSONS_QUEUE = "playbook-lessons.scan";

/** Weekly, Mondays 04:10 UTC — after the daily guideline scanners. */
export const PLAYBOOK_LESSONS_CRON = "10 4 * * 1";

/** The proposal row this scanner files: `targetType/proposalType` = `playbook/update`. */
export const PLAYBOOK_TARGET_TYPE = "playbook";
export const PLAYBOOK_UPDATE_PROPOSAL_TYPE = "update";

// ── The knobs. UNVALIDATED — the same standing caveat the blocked-slot and
// structure scanners carry: no measurement says 3 runs / 2 failures beats any
// other pair. A hypothesis with a knob, not a finding. Instrument before tuning.

/** Graded closed runs a playbook needs before its history says anything. */
export const MIN_EVALUATED_SESSIONS = 3;
/**
 * How many of those runs a criterion must have failed in (or been overridden
 * in) before it becomes a finding. Two, not one: one failure is a run that went
 * wrong, two is a pattern the stage should have warned about.
 */
export const MIN_FINDING_OCCURRENCES = 2;
/** Evidence lookback. A lesson learned from runs older than this is stale. */
export const WINDOW_DAYS = 90;
/** Playbooks examined per pass. */
const SCAN_LIMIT = 200;
/** Findings sent to the IS for one stage (its request schema caps at 12). */
const MAX_FINDINGS_PER_STAGE = 8;
/**
 * IS calls one pass may spend. The cost is one call per REVISED STAGE, so
 * `SCAN_LIMIT` playbooks × their stage count is the unbounded product this
 * bounds — a weekly pass over 200 multi-stage playbooks could otherwise spend
 * four figures of model calls in one go. Playbooks past the budget are not
 * degraded, they simply WAIT: the pass logs that it stopped, and next week's
 * pass sees the same evidence (the window is 90 days).
 */
export const MAX_IS_CALLS_PER_PASS = 120;

// ── Pure tier (no DB, no IS — the thresholds are testable on fixtures) ──────

/** A playbook stage as it is stored: an untyped jsonb bag with a `key`. */
export type StoredStage = Record<string, unknown> & { key?: unknown };

export interface StageRevision {
  stageKey: string;
  stageName: string;
  stageGoal?: string;
  existingLessons: string[];
  findings: StageLessonFinding[];
}

function stageKeyOf(stage: StoredStage): string | null {
  return typeof stage.key === "string" && stage.key.trim() ? stage.key : null;
}

function stageNameOf(stage: StoredStage, fallback: string): string {
  return typeof stage.name === "string" && stage.name.trim()
    ? stage.name
    : fallback;
}

/**
 * Criterion key → the stage that declares it. Built from the playbook's OWN
 * stages (`stage.criteria`), which is where `collectPlaybookCriteria` stamped
 * `stageKey` from when the session was instantiated — so the map answers the
 * same question the session rows were built with. A key declared by two stages
 * keeps the FIRST, matching `collectPlaybookCriteria`'s first-wins rule.
 */
export function criterionStageMap(stages: StoredStage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const stage of stages) {
    const key = stageKeyOf(stage);
    if (!key) continue;
    for (const c of readCriteria(stage.criteria)) {
      if (!map.has(c.key)) map.set(c.key, key);
    }
  }
  return map;
}

/**
 * The THRESHOLD, applied once, here. A criterion becomes a finding when — over
 * the scanned window — a REQUIRED one failed in at least `MIN_FINDING_OCCURRENCES`
 * runs, or a person overrode the automatic verdict on it that often. The two
 * are separate findings when both fire: "it keeps failing" and "the judge keeps
 * getting it wrong" ask for different lessons.
 *
 * `required` gates the FAILED arm only. An optional criterion that fails is not
 * a defect. An override is a person correcting the judge, which is worth
 * teaching whether or not the criterion was required.
 */
export function findingsForPlaybook(
  card: PlaybookScorecard,
  overrideRationales: Map<string, string>
): Map<string, StageLessonFinding[]> {
  const byCriterion = new Map<string, StageLessonFinding[]>();
  for (const c of card.criteria) {
    const out: StageLessonFinding[] = [];
    if (c.required && c.failed >= MIN_FINDING_OCCURRENCES) {
      out.push({
        statement: c.statement,
        kind: "failed",
        occurrences: c.failed,
      });
    }
    if (c.overrides >= MIN_FINDING_OCCURRENCES) {
      const rationale = overrideRationales.get(c.key);
      out.push({
        statement: c.statement,
        kind: "overridden",
        occurrences: c.overrides,
        ...(rationale ? { rationale } : {}),
      });
    }
    if (out.length) byCriterion.set(c.key, out);
  }
  return byCriterion;
}

/**
 * Which stages need revising, and with what evidence. Empty ⇒ nothing to
 * propose. A finding whose criterion belongs to no stage is dropped (see the
 * header: a lesson has nowhere to live without a stage).
 */
export function planStageRevisions(
  stages: StoredStage[],
  card: PlaybookScorecard,
  overrideRationales: Map<string, string>
): StageRevision[] {
  if (card.runs.evaluated < MIN_EVALUATED_SESSIONS) return [];
  const stageOf = criterionStageMap(stages);
  const findings = findingsForPlaybook(card, overrideRationales);
  const perStage = new Map<string, StageLessonFinding[]>();
  for (const [criterionKey, list] of findings) {
    const stageKey = stageOf.get(criterionKey);
    if (!stageKey) continue;
    perStage.set(stageKey, [...(perStage.get(stageKey) ?? []), ...list]);
  }

  const out: StageRevision[] = [];
  for (const stage of stages) {
    const key = stageKeyOf(stage);
    if (!key) continue;
    const list = perStage.get(key);
    if (!list?.length) continue;
    const goal = typeof stage.goal === "string" ? stage.goal : undefined;
    out.push({
      stageKey: key,
      stageName: stageNameOf(stage, key),
      ...(goal ? { stageGoal: goal } : {}),
      existingLessons: readStageLessons(stage),
      // Most-repeated first, so the IS's bounded prompt sees the worst offenders.
      findings: [...list]
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, MAX_FINDINGS_PER_STAGE),
    });
  }
  return out;
}

/** The key a playbook-level revision carries in place of a stage key. */
export const PLAYBOOK_LEVEL_KEY = "";

/**
 * The PLAYBOOK-level revision: the findings whose criterion no stage owns (a
 * playbook-level criterion, or any criterion of a stageless playbook), to be
 * reconciled into `metadata.lessons`. `null` ⇒ nothing to revise.
 */
export function planPlaybookRevision(
  playbook: { name: string; stages: StoredStage[]; metadata: unknown },
  card: PlaybookScorecard,
  overrideRationales: Map<string, string>
): StageRevision | null {
  if (card.runs.evaluated < MIN_EVALUATED_SESSIONS) return null;
  const stageOf = criterionStageMap(playbook.stages);
  const findings = [...findingsForPlaybook(card, overrideRationales)]
    .filter(([criterionKey]) => !stageOf.has(criterionKey))
    .flatMap(([, list]) => list);
  if (findings.length === 0) return null;
  return {
    stageKey: PLAYBOOK_LEVEL_KEY,
    stageName: playbook.name,
    existingLessons: readPlaybookLessons(playbook.metadata),
    findings: findings
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, MAX_FINDINGS_PER_STAGE),
  };
}

/**
 * What the successful runs used: each tool or skill that at least
 * `MIN_FINDING_OCCURRENCES` of them recorded, most used first, capped. `null`
 * when fewer than `MIN_EVALUATED_SESSIONS` runs succeeded (too few to say)
 * or nothing was used often enough.
 */
export function distilWhatWorked(
  successIds: readonly string[],
  used: ReadonlyMap<string, readonly RunUsedPart[]>
): WhatWorked | null {
  if (successIds.length < MIN_EVALUATED_SESSIONS) return null;
  const counts = new Map<
    string,
    { kind: RunUsedPart["kind"]; name: string; runs: number }
  >();
  for (const id of successIds) {
    for (const part of used.get(id) ?? []) {
      const key = `${part.kind}:${part.id}`;
      const c = counts.get(key) ?? { kind: part.kind, name: part.name, runs: 0 };
      c.runs += 1;
      counts.set(key, c);
    }
  }
  const parts = [...counts.values()]
    .filter((c) => c.runs >= MIN_FINDING_OCCURRENCES)
    .sort((a, b) => b.runs - a.runs || (a.name < b.name ? -1 : 1))
    .slice(0, MAX_WHAT_WORKED_PARTS);
  return parts.length > 0 ? { runs: successIds.length, parts } : null;
}

/**
 * The new `stages` array: every revised stage's `lessons` REPLACED, every other
 * stage byte-identical. Spread, never rebuilt — `playbooks.stages` is a loose
 * jsonb bag and an unknown key dropped here would be lost on approval.
 * A revision that reconciles down to NOTHING removes the key rather than
 * storing `[]`, so the stage reads exactly as a stage that never had lessons.
 */
export function applyRevisedLessons(
  stages: StoredStage[],
  revised: Map<string, string[]>
): StoredStage[] {
  return stages.map((stage) => {
    const key = stageKeyOf(stage);
    if (!key || !revised.has(key)) return stage;
    const lessons = revised.get(key)!;
    if (lessons.length === 0) {
      const { lessons: _dropped, ...rest } = stage;
      return rest;
    }
    return { ...stage, lessons };
  });
}

/** The reviewer-facing sentence. Prose, not a domain label — see the vocabulary rule. */
export function draftRationale(
  playbookName: string,
  revisions: StageRevision[],
  card: PlaybookScorecard,
  whatWorked: WhatWorked | null = null
): string {
  const parts: string[] = [];
  if (revisions.length > 0) {
    const where = revisions
      .map((r) =>
        r.stageKey === PLAYBOOK_LEVEL_KEY ? "the playbook as a whole" : r.stageName
      )
      .join(", ");
    const total = revisions.reduce((n, r) => n + r.findings.length, 0);
    parts.push(
      `Across ${card.runs.evaluated} graded runs of "${playbookName}", ${total} ` +
        `recurring problem${total === 1 ? "" : "s"} showed up in ${where}. ` +
        `These lessons are the rewritten guidance — review and edit before approving.`
    );
  }
  if (whatWorked) {
    parts.push(
      `${whatWorked.runs} runs of "${playbookName}" met every required criterion; ` +
        `the tools and skills most of them used are listed as what worked.`
    );
  }
  return parts.join(" ");
}

// ── The scan (DB + IS injected, so the whole pass is testable) ──────────────

export interface LessonsScanPlaybook {
  id: string;
  name: string;
  workspaceId: string | null;
  stages: StoredStage[];
  /** Where the playbook-level lessons and what worked live. */
  metadata: Record<string, unknown>;
  /** The human whose runs are the evidence — sessions are owner-private. */
  userId: string;
}

export interface PlaybookLessonsProposalData {
  /**
   * Read by the `playbook/update` executor's REPLAYED set: only the keys
   * present are written. `metadata` carries only `lessons` / `whatWorked`;
   * the update door merges it over the stored bag.
   */
  data: {
    id: string;
    stages?: StoredStage[];
    metadata?: { lessons?: string[]; whatWorked?: WhatWorked | null };
  };
  rationale: string;
  /** Lineage: the graded sessions this revision was derived from. */
  sourceSessionIds: string[];
  /** Marks this as the lessons scanner's own revision (the supersede key). */
  lessonsRevision: true;
  summary: string;
  evidence: {
    evaluatedRuns: number;
    windowDays: number;
    stages: Array<{
      stageKey: string;
      before: string[];
      after: string[];
      findings: StageLessonFinding[];
    }>;
    /** The playbook-level lessons, when they were revised. */
    playbook?: {
      before: string[];
      after: string[];
      findings: StageLessonFinding[];
    };
    /** What the successful runs used, when it changed. */
    whatWorked?: { before: WhatWorked | null; after: WhatWorked };
  };
}

export interface PlaybookLessonsScanDeps {
  /**
   * Candidate playbooks, each with the user whose closed runs to grade.
   * `closedAfter` is passed IN rather than re-derived, so the pass has ONE
   * clock: a fake `now()` moves the prefilter window and the scorecard window
   * together, as the real one does.
   */
  loadCandidates(closedAfter: Date): Promise<LessonsScanPlaybook[]>;
  /** Scorecard rows for one playbook + user, windowed. */
  loadRows(
    playbookId: string,
    userId: string,
    closedAfter: Date
  ): Promise<{
    sessions: ScorecardSessionRow[];
    evaluations: ScorecardEvaluationRow[];
  }>;
  /** What each run recorded using (`loadRunsUsedParts`). */
  loadUsedParts(sessionIds: string[]): Promise<Map<string, RunUsedPart[]>>;
  /** True ⇒ an open revision already exists for this playbook; skip it. */
  hasOpenRevision(playbookId: string): Promise<boolean>;
  /** Throws when the IS cannot answer — the caller skips the playbook. */
  reviseLessons(payload: ReviseLessonsRequest): Promise<string[]>;
  fileProposal(
    playbook: LessonsScanPlaybook,
    data: PlaybookLessonsProposalData
  ): Promise<string>;
  now(): Date;
}

/** Runs one pass; returns the ids of every filed proposal. */
export async function runPlaybookLessonsScan(
  deps: PlaybookLessonsScanDeps
): Promise<string[]> {
  const closedAfter = new Date(
    deps.now().getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const candidates = await deps.loadCandidates(closedAfter);
  const filed: string[] = [];
  let isCalls = 0;

  for (const playbook of candidates) {
    try {
      const { sessions, evaluations } = await deps.loadRows(
        playbook.id,
        playbook.userId,
        closedAfter
      );
      // INSTANTIATED runs only. A session ATTACHED to this playbook while
      // already live (`metadata.followedVia`) did not run under it — most of
      // its work happened before the definition was bound — so it is not
      // evidence that the playbook's stages need revising. It still COUNTS on
      // the scorecard (`runs.attached`, reported beside `runs.instantiated`);
      // it is excluded HERE, where a number becomes a governed `playbook/update`
      // proposal that feeds the trusted-agent widening lane.
      const mine = sessions.filter(
        (s) => s.playbookId === playbook.id && !s.attached
      );
      const card = projectPlaybookScorecard(mine, evaluations);

      // Lineage + the overriding person's own words, from the SAME rows the
      // projection read — never a second query.
      const closedIds = new Set(
        mine.filter((s) => s.status === "closed").map((s) => s.id)
      );
      const closedRows = evaluations.filter((e) => closedIds.has(e.sessionId));
      const overrideRationales = new Map<string, string>();
      for (const o of findOverrides(closedRows)) {
        if (o.rationale && !overrideRationales.has(o.criterionKey)) {
          overrideRationales.set(o.criterionKey, o.rationale);
        }
      }

      const stageRevisions = planStageRevisions(
        playbook.stages,
        card,
        overrideRationales
      );
      const playbookRevision = planPlaybookRevision(
        playbook,
        card,
        overrideRationales
      );
      const revisions = playbookRevision
        ? [...stageRevisions, playbookRevision]
        : stageRevisions;

      // What worked: counted from the successful runs' recorded tools and
      // skills, never asked of the IS.
      const successIds = successfulRunIds(mine, evaluations);
      const whatWorkedBefore = readWhatWorked(playbook.metadata);
      const whatWorked =
        successIds.length >= MIN_EVALUATED_SESSIONS
          ? distilWhatWorked(
              successIds,
              await deps.loadUsedParts(successIds)
            )
          : null;
      const workedChanged =
        whatWorked !== null &&
        JSON.stringify(whatWorked) !== JSON.stringify(whatWorkedBefore);

      if (revisions.length === 0 && !workedChanged) continue;

      // SUPERSEDE, checked AFTER the thresholds and BEFORE the IS is paid: a
      // second open edit to the same `stages` array would silently clobber the
      // first on approval, whichever order a reviewer takes them in.
      if (await deps.hasOpenRevision(playbook.id)) {
        logger.debug(
          { playbookId: playbook.id },
          "playbook-lessons-scanner: an open revision already exists — skipping"
        );
        continue;
      }

      // Checked BEFORE any of this playbook's calls, never mid-playbook: a
      // partially revised playbook is not a proposal (see `isFailed` below),
      // so spending the last of the budget on one would waste it.
      if (isCalls + revisions.length > MAX_IS_CALLS_PER_PASS) {
        logger.info(
          { playbookId: playbook.id, isCalls, budget: MAX_IS_CALLS_PER_PASS },
          "playbook-lessons-scanner: IS call budget reached — remaining playbooks wait for the next pass"
        );
        break;
      }

      const revised = new Map<string, string[]>();
      let isFailed = false;
      for (const revision of revisions) {
        try {
          isCalls += 1;
          const lessons = await deps.reviseLessons({
            playbookName: playbook.name,
            stage: {
              name: revision.stageName,
              ...(revision.stageGoal ? { goal: revision.stageGoal } : {}),
            },
            existingLessons: revision.existingLessons,
            findings: revision.findings,
          });
          // The pod's OWN bound, whatever the IS returned.
          revised.set(revision.stageKey, readStageLessons({ lessons }));
        } catch (err) {
          logger.warn(
            { err, playbookId: playbook.id, stageKey: revision.stageKey },
            "playbook-lessons-scanner: IS could not revise — skipping this playbook entirely"
          );
          isFailed = true;
          break;
        }
      }
      // A partial answer is not a proposal: approving it would write reconciled
      // lessons for one stage and leave the rest silently unrevised.
      if (isFailed) continue;

      // Nothing actually changed ⇒ nothing to review.
      const changedLessons = (r: StageRevision) =>
        JSON.stringify(revised.get(r.stageKey) ?? []) !==
        JSON.stringify(r.existingLessons);
      const stagesChanged = stageRevisions.some(changedLessons);
      const playbookChanged =
        playbookRevision !== null && changedLessons(playbookRevision);
      if (!stagesChanged && !playbookChanged && !workedChanged) continue;

      const sourceSessionIds = [
        ...new Set([
          ...closedRows.map((e) => e.sessionId),
          ...(workedChanged ? successIds : []),
        ]),
      ].slice(0, 20);

      const metadata: NonNullable<
        PlaybookLessonsProposalData["data"]["metadata"]
      > = {
        ...(playbookChanged
          ? { lessons: revised.get(PLAYBOOK_LEVEL_KEY) ?? [] }
          : {}),
        ...(workedChanged ? { whatWorked } : {}),
      };
      const data: PlaybookLessonsProposalData = {
        data: {
          id: playbook.id,
          ...(stagesChanged
            ? { stages: applyRevisedLessons(playbook.stages, revised) }
            : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
        rationale: draftRationale(
          playbook.name,
          revisions,
          card,
          workedChanged ? whatWorked : null
        ),
        sourceSessionIds,
        lessonsRevision: true,
        summary: `Revise what earlier runs taught "${playbook.name}"`,
        evidence: {
          evaluatedRuns: card.runs.evaluated,
          windowDays: WINDOW_DAYS,
          stages: stageRevisions.map((r) => ({
            stageKey: r.stageKey,
            before: r.existingLessons,
            after: revised.get(r.stageKey) ?? [],
            findings: r.findings,
          })),
          ...(playbookRevision && playbookChanged
            ? {
                playbook: {
                  before: playbookRevision.existingLessons,
                  after: revised.get(PLAYBOOK_LEVEL_KEY) ?? [],
                  findings: playbookRevision.findings,
                },
              }
            : {}),
          ...(workedChanged && whatWorked
            ? { whatWorked: { before: whatWorkedBefore, after: whatWorked } }
            : {}),
        },
      };
      filed.push(await deps.fileProposal(playbook, data));
    } catch (err) {
      logger.error(
        { err, playbookId: playbook.id },
        "playbook-lessons-scanner: failed for playbook, skipping"
      );
    }
  }
  return filed;
}

// ── DB tier ──────────────────────────────────────────────────────────────────

/**
 * Playbooks with enough closed, graded runs to say anything — one row per
 * (playbook, owner), because sessions are owner-private and two people's runs
 * of one playbook are two histories. The count here is a CHEAP PREFILTER on
 * closed runs; the real `evaluated` threshold is applied by the projection, so
 * this floor must never be STRICTER than `MIN_EVALUATED_SESSIONS` or it would
 * hide rows the threshold would have accepted.
 */
async function loadCandidatePlaybooks(
  closedAfter: Date
): Promise<LessonsScanPlaybook[]> {
  // Expressed in the QUERY BUILDER, not `db.execute`, deliberately: a raw
  // `execute` returns a bare array on postgres.js and `{ rows }` on PGlite, so
  // the same correct SQL reads as zero candidates under one driver. The builder
  // returns a plain array everywhere, and the column names are typed.
  const pairs = await db
    .select({
      playbookId: focusSessions.playbookId,
      userId: focusSessions.userId,
    })
    .from(focusSessions)
    .where(
      and(
        isNotNull(focusSessions.playbookId),
        eq(focusSessions.status, "closed"),
        drizzleSql`${focusSessions.closedAt} > ${closedAfter.toISOString()}`
      )
    )
    .groupBy(focusSessions.playbookId, focusSessions.userId)
    .having(drizzleSql`count(*) >= ${MIN_EVALUATED_SESSIONS}`)
    .limit(SCAN_LIMIT);
  if (pairs.length === 0) return [];

  const rows = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      workspaceId: playbooks.workspaceId,
      stages: playbooks.stages,
      metadata: playbooks.metadata,
      status: playbooks.status,
    })
    .from(playbooks)
    .where(
      inArray(
        playbooks.id,
        pairs.map((p) => String(p.playbookId))
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  return pairs.flatMap((p) => {
    const row = byId.get(String(p.playbookId));
    // An archived playbook is not worth teaching.
    if (!row || row.status === "archived") return [];
    return [
      {
        id: row.id,
        name: row.name,
        workspaceId: row.workspaceId ?? null,
        stages: Array.isArray(row.stages) ? (row.stages as StoredStage[]) : [],
        metadata:
          row.metadata && typeof row.metadata === "object"
            ? (row.metadata as Record<string, unknown>)
            : {},
        userId: String(p.userId),
      },
    ];
  });
}

/**
 * The REAL DB tier. Exported so the PGlite test can drive `loadCandidates`,
 * `hasOpenRevision` and `fileProposal` against real SQL with only the IS
 * injected — a hand-built fake would only prove the fake.
 */
export const playbookLessonsDbDeps: PlaybookLessonsScanDeps = {
  now: () => new Date(),

  loadCandidates: (closedAfter) => loadCandidatePlaybooks(closedAfter),

  loadRows: (playbookId, userId, closedAfter) =>
    loadPlaybookScorecardRows(db, {
      playbookIds: [playbookId],
      userId,
      closedAfter,
    }),

  loadUsedParts: (sessionIds) => loadRunsUsedParts(db, sessionIds),

  /**
   * ANY pending `playbook/update` for this playbook counts, not only one this
   * scanner filed: both carry a whole `stages` array, so approving the second
   * reverts the first's edits. Deliberately broader than "no second revision".
   */
  async hasOpenRevision(playbookId) {
    const rows = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.targetType, PLAYBOOK_TARGET_TYPE),
          eq(proposals.proposalType, PLAYBOOK_UPDATE_PROPOSAL_TYPE),
          eq(proposals.targetId, playbookId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      )
      .limit(1);
    return rows.length > 0;
  },

  async reviseLessons(payload) {
    const { endpoint, apiKey } = await getDefaultActiveService();
    if (!endpoint) throw new Error("No active intelligence service configured");
    const answer = await requestRevisedLessons(endpoint, apiKey ?? "", payload);
    return answer.lessons;
  },

  async fileProposal(playbook, data) {
    const { proposal } = await insertPendingProposal(
      {
        workspaceId: playbook.workspaceId,
        targetType: PLAYBOOK_TARGET_TYPE,
        targetId: playbook.id,
        proposalType: PLAYBOOK_UPDATE_PROPOSAL_TYPE,
        data: data as unknown as Record<string, unknown>,
        createdBy: playbook.userId,
        proposedByUserId: null,
        // OWNER FLOOR (0248): the human whose runs taught this decides.
        subjectUserId: playbook.userId,
      },
      db
    );

    void emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId: playbook.userId,
      data: {
        proposalStatus: "created",
        targetType: PLAYBOOK_TARGET_TYPE,
        changeType: PLAYBOOK_UPDATE_PROPOSAL_TYPE,
      },
    }).catch((err) => {
      logger.warn(
        { err, proposalId: proposal.id },
        "playbook-lessons-scanner: emitSideEffects failed (non-fatal)"
      );
    });

    logger.info(
      {
        playbookId: playbook.id,
        proposalId: proposal.id,
        stages: data.evidence.stages.length,
        playbookLevel: data.evidence.playbook !== undefined,
        whatWorked: data.evidence.whatWorked !== undefined,
      },
      "playbook-lessons-scanner: filed a lessons revision proposal"
    );
    return proposal.id;
  },
};

/**
 * Cron / on-demand handler. Manual trigger:
 * `await boss.send("playbook-lessons.scan", {})`
 */
export async function handlePlaybookLessonsScan(
  deps: PlaybookLessonsScanDeps = playbookLessonsDbDeps
): Promise<string[]> {
  logger.info("playbook-lessons-scanner: starting scan");
  const filed = await runPlaybookLessonsScan(deps);
  logger.info(
    { filed: filed.length },
    "playbook-lessons-scanner: scan complete"
  );
  return filed;
}
