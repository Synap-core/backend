/**
 * Track Repository — `project_tracks` writes with automatic event emission.
 *
 * Emits `track.create.completed` / `track.update.completed` /
 * `track.delete.completed` through the EventRepository (the FACT bus: SSE,
 * realtime, peer sync — see BaseRepository). Governance and visibility are the
 * CALLER's job (api `services/tracks`); this layer only writes rows.
 *
 * EVERY write to `project_tracks` goes through here — including the guarded
 * compare-and-set writes of the stage gate (`transitionStatus`,
 * `advanceStage`) — so no status or stage change can land without its
 * `track.update.completed` fact. A STATUS change has exactly one writer,
 * `transitionStatus`, which also owes the goal's transition
 * (`track.transition.completed`, status-flow W1) in the same transaction.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { TRACK_STATUS_DECLARATION } from "@synap-core/types/units";
import {
  LIVE_PROJECT_TRACK_STATUSES,
  projectTracks,
} from "../schema/project-tracks.js";
import { projects } from "../schema/projects.js";
import { insertTransitionOutbox } from "../services/lifecycle/transition-outbox.js";
import {
  buildWorkUnitTransition,
  workUnitActorOf,
  type WorkUnitActor,
} from "../services/lifecycle/work-unit-transition.js";
import { getActingAgentUserId } from "../utils/request-write-context.js";
import { HoldRefusedError, listHolds } from "../services/lifecycle/holds.js";
import { decideMoveHold, type Hold } from "@synap-core/types/lifecycle";
import type {
  ProjectTrack,
  ProjectTrackDefinitionSnapshot,
  ProjectTrackKpi,
  ProjectTrackStageHistoryEntry,
  ProjectTrackStatus,
  ProjectTrackUncertainty,
  ProjectTrackVerdict,
  ProjectTrackWorkKind,
} from "../schema/project-tracks.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";

export interface CreateTrackInput {
  /** Pre-minted id (the governed door mints it once so a receipt names a real row). */
  id?: string;
  projectId: string;
  playbookId: string | null;
  name: string;
  definitionSnapshot: ProjectTrackDefinitionSnapshot;
  methodVersion: string;
  currentStage: string | null;
  /** The method's param answers given at start (0274). */
  params?: Record<string, unknown>;
  /** Where the track is heading (0302). */
  direction?: string | null;
  /** The number it steers by (0302), already validated by the caller. */
  kpi?: ProjectTrackKpi | null;
  /** What a goal holds (0345), already validated by the caller. */
  goal?: TrackGoalPatch;
  metadata?: Record<string, unknown>;
}

/**
 * WHAT A GOAL HOLDS (0345) — each field WHOLE: `undefined` leaves it alone,
 * `null` clears it. Validation (the 2–5 criteria rule, the meanings, who
 * confirmed the kind) and governance are the caller's (`services/tracks`).
 * `criteria` never carries a judge's decision the caller made up: the
 * service carries each stored `acceptance` over, and the ONE writer of a new
 * one is {@link TrackRepository.setCriterionAcceptance}.
 */
export interface TrackGoalPatch {
  endState?: string | null;
  criteria?: unknown[] | null;
  dropConditions?: string[] | null;
  workKind?: ProjectTrackWorkKind | null;
  uncertainty?: ProjectTrackUncertainty | null;
  kindConfirmedBy?: string | null;
  kindConfirmedAt?: Date | null;
  /** The goal's loop (0350) — written WHOLE; `null` clears it (off). */
  loop?: Record<string, unknown> | null;
}

/**
 * A DIRECTION / KPI patch (0302). `undefined` leaves a field alone; `null`
 * clears it. `kpi` (an object) is MERGED onto the stored KPI in SQL — only
 * the keys it names change, so a person moving the target and an agent
 * stating the current value cannot revert each other.
 */
export interface TrackDirectionPatch {
  direction?: string | null;
  kpi?: Partial<ProjectTrackKpi> | null;
  /** What a goal holds (0345) — each field written whole. */
  goal?: TrackGoalPatch;
  /**
   * COMPARE-AND-SET on the criteria (code.md): the stored criteria as the
   * caller READ them. Set whenever the patch writes criteria whole, so a
   * judge's decision stamped in between (`setCriterionAcceptance`) is never
   * silently dropped — the write lands only while the criteria still are what
   * the caller merged onto (`null` back: gone, or changed). `undefined` = no
   * check.
   */
  expectedCriteria?: unknown;
}

/** One stage appended to a running track (`appendStage`). */
export interface AppendedTrackStage {
  key: string;
  name: string;
  /** The closed rollup category every stored stage carries. */
  category: string;
  goal?: string;
  /** ISO-8601 — marks the stage as EMERGENT (added after the track started). */
  addedAt: string;
  /** The user (or agent) id that added it. */
  addedBy: string;
}

export interface UpdateTrackInput {
  /** `undefined` leaves the stage untouched; `null` clears it. */
  currentStage?: string | null;
  name?: string;
}

export interface CreateTrackResult {
  track: ProjectTrack;
  /** False when a live track of the same name already existed (idempotent). */
  created: boolean;
}

export class TrackRepository extends BaseRepository<
  ProjectTrack,
  CreateTrackInput,
  UpdateTrackInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "track", pluralName: "tracks" });
  }

  /**
   * Insert a track, IDEMPOTENT on the live-name unique index
   * (`uniq_project_tracks_live_name`, 0317): a second start under a name a
   * LIVE track (active/paused) of the project already holds returns that
   * track, `created: false`, and emits nothing — whatever its method; the
   * caller decides what a same-name track of ANOTHER method means. The INSERT
   * itself is the arbiter (ON CONFLICT DO NOTHING), so two concurrent starts
   * cannot both create.
   */
  async createOrGet(
    data: CreateTrackInput,
    userId: string
  ): Promise<CreateTrackResult> {
    const [inserted] = await this.db
      .insert(projectTracks)
      .values({
        ...(data.id ? { id: data.id } : {}),
        projectId: data.projectId,
        userId,
        playbookId: data.playbookId,
        name: data.name,
        definitionSnapshot: data.definitionSnapshot,
        methodVersion: data.methodVersion,
        currentStage: data.currentStage,
        params: data.params ?? {},
        direction: data.direction ?? null,
        kpi: data.kpi ?? null,
        ...goalSet(data.goal),
        // The birth seed of the stage history (0274): the first stage is
        // ENTERED at birth, the same moment `current_stage` is seeded.
        stageHistory: data.currentStage
          ? [
              {
                stageKey: data.currentStage,
                fromStage: null,
                enteredAt: new Date().toISOString(),
                actor: userId,
              } satisfies ProjectTrackStageHistoryEntry,
            ]
          : [],
        status: "active",
        metadata: data.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      await this.emitCompleted("create", inserted, userId);
      return { track: inserted as ProjectTrack, created: true };
    }

    const existing = await this.findLiveByName(data.projectId, data.name);
    if (!existing) {
      // Not the live-name index, so a primary-key collision (a replayed id).
      throw new Error(
        "Track insert conflicted but no live track holds its name"
      );
    }
    return { track: existing as ProjectTrack, created: false };
  }

  /**
   * The LIVE track holding `name` on the project, or `null`. The ONE spelling
   * in TS of `uniq_project_tracks_live_name`'s predicate (0317): same project,
   * `lower(btrim(name))`, a live status (open, active or paused — 0344).
   */
  async findLiveByName(
    projectId: string,
    name: string
  ): Promise<ProjectTrack | null> {
    const [live] = await this.db
      .select()
      .from(projectTracks)
      .where(
        and(
          eq(projectTracks.projectId, projectId),
          sql`lower(btrim(${projectTracks.name})) = lower(btrim(${name}))`,
          inArray(projectTracks.status, [...LIVE_PROJECT_TRACK_STATUSES])
        )
      )
      .limit(1);
    return (live as ProjectTrack | undefined) ?? null;
  }

  async create(data: CreateTrackInput, userId: string): Promise<ProjectTrack> {
    return (await this.createOrGet(data, userId)).track;
  }

  /**
   * Patch a track. Emits `track.update.completed`. Throws when the row is gone.
   */
  async update(
    id: string,
    data: UpdateTrackInput,
    userId: string
  ): Promise<ProjectTrack> {
    const [track] = await this.db
      .update(projectTracks)
      .set({
        // `undefined` keys are dropped by Drizzle's SET (field untouched).
        // Never the status: `transitionStatus` is its one writer.
        currentStage: data.currentStage,
        name: data.name,
        updatedAt: new Date(),
      })
      .where(eq(projectTracks.id, id))
      .returning();
    if (!track) throw new Error("Track not found");
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * Guarded status flip: `from → to`, ONLY while the row still stands at
   * `from` (the WHERE is the arbiter, so a decision and its write cannot
   * disagree). `metadataPatch` is merged into metadata; `dropMetadataKey` is
   * removed after the merge. `close` stamps how the track ended (0344) in the
   * SAME statement as the status — the caller (the status door) has checked
   * the verdict fits the ending; the `project_tracks_verdict_check` constraint
   * refuses one that does not. Returns the updated row, or `null` when no row
   * flipped — and emits `track.update.completed` only when one did.
   *
   * THE GOAL'S TRANSITION (status-flow W1): a flip also owes
   * `track.transition.completed` — the one transition shape, categories from
   * `TRACK_STATUS_DECLARATION` — through the transition outbox, in the SAME
   * transaction as the flip (delivered by the sweeper). `actor` defaults to
   * the acting agent when an agent key made the call, else the person.
   */
  async transitionStatus(
    id: string,
    params: {
      from: ProjectTrackStatus;
      to: ProjectTrackStatus;
      metadataPatch?: Record<string, unknown>;
      dropMetadataKey?: string;
      close?: {
        verdict: ProjectTrackVerdict;
        reason: string | null;
        by: string;
        at?: Date;
      };
      actor?: WorkUnitActor;
      reason?: string | null;
      proposalId?: string | null;
      /**
       * What a pause waits on (`decideMoveHold`: refused from an agent when
       * absent; `defaultHold`, else `unspecified`, for a person or the
       * system). A goal already paused keeps the hold it had.
       */
      hold?: Hold | null;
      defaultHold?: Hold;
      /** When it really happened (already bounded by the door). */
      occurredAt?: Date | null;
    },
    userId: string
  ): Promise<ProjectTrack | null> {
    const { metadataPatch, dropMetadataKey, close } = params;
    let metadata = sql`COALESCE(${projectTracks.metadata}, '{}'::jsonb)`;
    if (metadataPatch) {
      metadata = sql`(${metadata} || ${JSON.stringify(metadataPatch)}::jsonb)`;
    }
    if (dropMetadataKey) {
      metadata = sql`(${metadata} - ${dropMetadataKey}::text)`;
    }
    const actor =
      params.actor ?? workUnitActorOf(userId, getActingAgentUserId());
    const fromCategory = TRACK_STATUS_DECLARATION[params.from].category;
    const track = await this.db.transaction(async (tx: any) => {
      // The hold is decided BEFORE the flip: a refused pause writes nothing.
      const decided = decideMoveHold({
        from: params.from,
        fromCategory,
        toCategory: TRACK_STATUS_DECLARATION[params.to].category,
        actorKind: actor.kind,
        approved: Boolean(params.proposalId),
        given: params.hold,
        current:
          fromCategory === "paused"
            ? ((
                await listHolds(tx, {
                  subjects: [{ subjectType: "track", subjectId: id }],
                })
              )[0]?.hold ?? null)
            : null,
        fallback: params.defaultHold,
        since: params.occurredAt ?? new Date(),
      });
      if (!decided.ok) throw new HoldRefusedError(decided);
      const [flipped] = await tx
        .update(projectTracks)
        .set({
          status: params.to,
          ...(metadataPatch || dropMetadataKey ? { metadata } : {}),
          ...(close
            ? {
                verdict: close.verdict,
                verdictReason: close.reason,
                verdictBy: close.by,
                verdictAt: close.at ?? new Date(),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(projectTracks.id, id), eq(projectTracks.status, params.from))
        )
        .returning();
      if (!flipped) return null;
      const [project] = await tx
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, flipped.projectId))
        .limit(1);
      await insertTransitionOutbox(
        tx,
        buildWorkUnitTransition({
          subjectType: "track",
          subjectId: flipped.id,
          from: params.from,
          to: params.to,
          fromCategory,
          category: TRACK_STATUS_DECLARATION[params.to].category,
          actor,
          ownerUserId: userId,
          reason: params.reason,
          proposalId: params.proposalId,
          occurredAt: params.occurredAt,
          hold: decided.hold,
          workspaceId: project?.workspaceId ?? null,
          projectId: flipped.projectId,
          trackId: flipped.id,
        })
      );
      return flipped as ProjectTrack;
    });
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track;
  }

  /**
   * Compare-and-set stage write: moves to `toStage` ONLY while the row still
   * stands on `fromStage` (`IS NOT DISTINCT FROM`, so a NULL stage compares).
   * Returns `null` when another writer moved it first — the caller refuses.
   *
   * THE ONE APPEND of `stage_history` (0274), in the SAME UPDATE as the stage:
   * a history entry exists iff the stage write landed, and a lost CAS appends
   * nothing. A re-entered stage appends a new entry. `actor` defaults to
   * `userId` (pass the agent's id when an agent drove the advance).
   */
  async advanceStage(
    id: string,
    fromStage: string | null,
    toStage: string,
    userId: string,
    actor: string = userId
  ): Promise<ProjectTrack | null> {
    const entry: ProjectTrackStageHistoryEntry = {
      stageKey: toStage,
      fromStage,
      enteredAt: new Date().toISOString(),
      actor,
    };
    const [track] = await this.db
      .update(projectTracks)
      .set({
        currentStage: toStage,
        stageHistory: sql`(COALESCE(${projectTracks.stageHistory}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTracks.id, id),
          sql`${projectTracks.currentStage} IS NOT DISTINCT FROM ${fromStage}`
        )
      )
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * Stamp a check gate's verdict on the stage-history entry its move appended
   * — the entry whose `enteredAt` is `enteredAt` and which is still the LAST
   * one (a later move means this verdict no longer describes the newest entry;
   * it is then written onto the matching entry wherever it sits). Not an
   * append: the timeline keeps exactly one entry per move. Returns the row, or
   * `null` when no entry matched. Emits `track.update.completed` like every
   * track write.
   */
  async stampStageCheck(
    id: string,
    enteredAt: string,
    check: { passed: boolean; failing: string[]; reason?: string },
    userId: string
  ): Promise<ProjectTrack | null> {
    const [track] = await this.db
      .update(projectTracks)
      .set({
        stageHistory: sql`(
          SELECT COALESCE(jsonb_agg(
            CASE WHEN e->>'enteredAt' = ${enteredAt}
              THEN e || jsonb_build_object('check', ${JSON.stringify(check)}::jsonb)
              ELSE e END
            ORDER BY i), '[]'::jsonb)
          FROM jsonb_array_elements(${projectTracks.stageHistory}) WITH ORDINALITY AS t(e, i)
        )`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTracks.id, id),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${projectTracks.stageHistory}) e WHERE e->>'enteredAt' = ${enteredAt})`
        )
      )
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * PATCH the track's param answers (0274), merged IN SQL:
   * `(params || set) - clear`. Only the keys this write names change, so two
   * concurrent answers to different params both land — a read-modify-write of
   * the whole bag let the later writer silently revert the earlier one.
   * Emits `track.update.completed`. Returns `null` when the row is gone.
   * Validation and governance are the caller's (`setTrackParams`).
   */
  async patchParams(
    id: string,
    patch: { set: Record<string, unknown>; clear: string[] },
    userId: string
  ): Promise<ProjectTrack | null> {
    const [track] = await this.db
      .update(projectTracks)
      .set({
        params: sql`((COALESCE(${projectTracks.params}, '{}'::jsonb) || ${JSON.stringify(patch.set)}::jsonb) - ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(patch.clear)}::jsonb)))`,
        updatedAt: new Date(),
      })
      .where(eq(projectTracks.id, id))
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * Write a track's DIRECTION and/or KPI (0302). The KPI is merged IN SQL
   * (`kpi || patch`, a NULL stored KPI read as `{}`), so only the keys this
   * write names change; `kpi: null` clears it. Validation and governance are
   * the caller's (`setTrackDirection`). Emits `track.update.completed`.
   * Returns `null` when the row is gone.
   */
  async patchDirection(
    id: string,
    patch: TrackDirectionPatch,
    userId: string
  ): Promise<ProjectTrack | null> {
    const kpi =
      patch.kpi === undefined
        ? undefined
        : patch.kpi === null
          ? null
          : sql`(COALESCE(${projectTracks.kpi}, '{}'::jsonb) || ${JSON.stringify(patch.kpi)}::jsonb)`;
    const [track] = await this.db
      .update(projectTracks)
      .set({
        // `undefined` keys are dropped by Drizzle's SET (field untouched).
        direction: patch.direction,
        kpi,
        ...goalSet(patch.goal),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTracks.id, id),
          patch.expectedCriteria === undefined
            ? undefined
            : sql`${projectTracks.criteria} IS NOT DISTINCT FROM ${
                patch.expectedCriteria === null
                  ? null
                  : JSON.stringify(patch.expectedCriteria)
              }::jsonb`
        )
      )
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * Stamp the judge's decision on ONE goal criterion (R2) — the one writer of
   * a criterion's `acceptance`. Rewritten IN SQL, entry by entry, so a
   * decision on one criterion cannot revert another's, and only while the
   * criterion still exists (`null` = gone or no such key). Who may decide is
   * the caller's (`acceptGoalCriterion`). Emits `track.update.completed`.
   */
  async setCriterionAcceptance(
    id: string,
    criterionKey: string,
    acceptance: Record<string, unknown>,
    userId: string
  ): Promise<ProjectTrack | null> {
    const entries = sql`(CASE WHEN jsonb_typeof(${projectTracks.criteria}) = 'array' THEN ${projectTracks.criteria} ELSE '[]'::jsonb END)`;
    const [track] = await this.db
      .update(projectTracks)
      .set({
        criteria: sql`(SELECT jsonb_agg(CASE WHEN t.e ->> 'key' = ${criterionKey} THEN t.e || jsonb_build_object('acceptance', ${JSON.stringify(acceptance)}::jsonb) ELSE t.e END ORDER BY t.ord) FROM jsonb_array_elements(${entries}) WITH ORDINALITY AS t(e, ord))`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTracks.id, id),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${entries}) AS s(e) WHERE s.e ->> 'key' = ${criterionKey})`
        )
      )
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * Append ONE stage to the track's PINNED stage list
   * (`definition_snapshot.stages`) — the one writer of that list after birth.
   * Compare-and-set on the list as the caller read it: lands only while the
   * list still holds `expectedCount` stages AND no stage with this key, so two
   * concurrent adds cannot both append (the loser gets `null` and is told) and
   * a key can never be declared twice. `current_stage` and `stage_history` are
   * untouched: adding a stage never ENTERS it — `advanceStage` does, and it
   * now finds the key declared.
   */
  async appendStage(
    id: string,
    stage: AppendedTrackStage,
    expectedCount: number,
    userId: string
  ): Promise<ProjectTrack | null> {
    const stages = sql`COALESCE(${projectTracks.definitionSnapshot} -> 'stages', '[]'::jsonb)`;
    const [track] = await this.db
      .update(projectTracks)
      .set({
        definitionSnapshot: sql`jsonb_set(COALESCE(${projectTracks.definitionSnapshot}, '{}'::jsonb), '{stages}', (CASE WHEN jsonb_typeof(${stages}) = 'array' THEN ${stages} ELSE '[]'::jsonb END) || ${JSON.stringify([stage])}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTracks.id, id),
          sql`(CASE WHEN jsonb_typeof(${stages}) = 'array' THEN jsonb_array_length(${stages}) ELSE 0 END) = ${expectedCount}`,
          sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${stages}) = 'array' THEN ${stages} ELSE '[]'::jsonb END) AS s(e) WHERE s.e ->> 'key' = ${stage.key})`
        )
      )
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(projectTracks)
      .where(eq(projectTracks.id, id))
      .returning({ id: projectTracks.id });
    if (result.length === 0) throw new Error("Track not found");
    await this.emitCompleted(
      "delete",
      { id } as Partial<ProjectTrack> & { id: string },
      userId
    );
  }
}

/** The SET of a goal patch — only the keys it names (`undefined` = untouched). */
function goalSet(goal: TrackGoalPatch | undefined): Record<string, unknown> {
  if (!goal) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(goal)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
