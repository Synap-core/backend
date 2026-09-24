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
 * `track.update.completed` fact.
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { projectTracks } from "../schema/project-tracks.js";
import type {
  ProjectTrack,
  ProjectTrackDefinitionSnapshot,
  ProjectTrackStatus,
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
  metadata?: Record<string, unknown>;
}

export interface UpdateTrackInput {
  /** `undefined` leaves the stage untouched; `null` clears it. */
  currentStage?: string | null;
  status?: ProjectTrackStatus;
  name?: string;
}

export interface CreateTrackResult {
  track: ProjectTrack;
  /** False when a live track of the same method already existed (idempotent). */
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
   * Insert a track, IDEMPOTENT on the live-method unique index
   * (`uniq_project_tracks_live_method`): starting the same method twice on one
   * project returns the existing non-archived track, `created: false`, and
   * emits nothing. The INSERT itself is the arbiter (ON CONFLICT DO NOTHING),
   * so two concurrent starts cannot both create.
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
        status: "active",
        metadata: data.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      await this.emitCompleted("create", inserted, userId);
      return { track: inserted as ProjectTrack, created: true };
    }

    if (!data.playbookId) {
      // A conflict with no method can only be a primary-key collision, which a
      // defaultRandom id never produces. Say so rather than return nothing.
      throw new Error("Track insert conflicted without a method to dedup on");
    }
    const [existing] = await this.db
      .select()
      .from(projectTracks)
      .where(
        and(
          eq(projectTracks.projectId, data.projectId),
          eq(projectTracks.playbookId, data.playbookId),
          ne(projectTracks.status, "archived")
        )
      )
      .limit(1);
    if (!existing) {
      throw new Error("Track insert conflicted but no live track was found");
    }
    return { track: existing as ProjectTrack, created: false };
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
        currentStage: data.currentStage,
        status: data.status,
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
   * removed after the merge. Returns the updated row, or `null` when no row
   * flipped — and emits `track.update.completed` only when one did.
   */
  async transitionStatus(
    id: string,
    params: {
      from: ProjectTrackStatus;
      to: ProjectTrackStatus;
      metadataPatch?: Record<string, unknown>;
      dropMetadataKey?: string;
    },
    userId: string
  ): Promise<ProjectTrack | null> {
    const { metadataPatch, dropMetadataKey } = params;
    let metadata = sql`COALESCE(${projectTracks.metadata}, '{}'::jsonb)`;
    if (metadataPatch) {
      metadata = sql`(${metadata} || ${JSON.stringify(metadataPatch)}::jsonb)`;
    }
    if (dropMetadataKey) {
      metadata = sql`(${metadata} - ${dropMetadataKey}::text)`;
    }
    const [track] = await this.db
      .update(projectTracks)
      .set({
        status: params.to,
        ...(metadataPatch || dropMetadataKey ? { metadata } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(projectTracks.id, id), eq(projectTracks.status, params.from))
      )
      .returning();
    if (!track) return null;
    await this.emitCompleted("update", track, userId);
    return track as ProjectTrack;
  }

  /**
   * Compare-and-set stage write: moves to `toStage` ONLY while the row still
   * stands on `fromStage` (`IS NOT DISTINCT FROM`, so a NULL stage compares).
   * Returns `null` when another writer moved it first — the caller refuses.
   */
  async advanceStage(
    id: string,
    fromStage: string | null,
    toStage: string,
    userId: string
  ): Promise<ProjectTrack | null> {
    const [track] = await this.db
      .update(projectTracks)
      .set({ currentStage: toStage, updatedAt: new Date() })
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
