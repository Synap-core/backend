/**
 * Project Repository
 *
 * Handles all project CRUD operations with automatic event emission.
 * Projects are first-class table rows (projects pgTable), NOT entities.
 */

import { eq, and } from "drizzle-orm";
import { projects } from "../schema/projects.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Project } from "../schema/projects.js";
import {
  findProjectDedupCandidates,
  type ProjectProvenance,
  type ProjectDedupCandidate,
} from "../utils/project-guardrails.js";
import {
  slugifyProjectName,
  uniquifyProjectSlug,
} from "../utils/project-slug.js";
import { triggerCpProjectSync } from "../utils/cp-project-sync-trigger.js";

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId?: string | null;
  /**
   * Provenance stamp (who/where this create came from). Threaded from each
   * creation door and recorded into `metadata.provenance`. When omitted, any
   * `metadata.provenance` already on `metadata` is preserved.
   */
  provenance?: ProjectProvenance;
}

/**
 * A created project, plus dedup signals for the caller:
 *  - `deduped: true` ⇒ an exact-normalized-name match existed and this is the
 *    EXISTING project (idempotent create; nothing was inserted).
 *  - `dedupCandidates` ⇒ near-duplicate active projects (surfaced, not blocked).
 */
export type CreateProjectResult = Project & {
  deduped?: boolean;
  dedupCandidates?: ProjectDedupCandidate[];
};

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export class ProjectRepository extends BaseRepository<
  Project,
  CreateProjectInput,
  UpdateProjectInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "project", pluralName: "projects" });
  }

  /**
   * Create a new project.
   *
   * Dedup-before-create (the ONE door): an exact-normalized-name match among the
   * user's ACTIVE projects makes this idempotent — the existing project is
   * returned (`deduped: true`) and nothing is inserted. Near-duplicate active
   * projects are surfaced on the result (`dedupCandidates`) but never block a
   * human create. Provenance is stamped into `metadata.provenance`.
   *
   * Emits: projects.create.completed
   */
  async create(
    data: CreateProjectInput,
    userId: string
  ): Promise<CreateProjectResult> {
    const match = await findProjectDedupCandidates(this.db, {
      userId,
      name: data.name,
    });

    // Exact-normalized match → idempotent reuse. Return the existing row; no
    // second project is minted (this is what agents-per-repo/-task tripped on).
    if (match.exact) {
      const [existing] = await this.db
        .select()
        .from(projects)
        .where(eq(projects.id, match.exact.id));
      if (existing) {
        return {
          ...existing,
          deduped: true,
          ...(match.near.length > 0 ? { dedupCandidates: match.near } : {}),
        };
      }
      // Row vanished between load and re-read (rare race) → fall through and insert.
    }

    // Stamp provenance into metadata. An explicit `provenance` param wins; else
    // any provenance already carried on `metadata` (e.g. via a proposal) stays.
    const metadata: Record<string, unknown> = {
      ...(data.metadata ?? {}),
      ...(data.provenance ? { provenance: data.provenance } : {}),
    };

    // Slug (P4-lite W0): generated here — the ONE creation door — via the ONE
    // slugify helper, uniquified against the user's existing slugs. The partial
    // unique index (user_id, slug) is the final arbiter on a rare race.
    const existingSlugRows: Array<{ slug: string | null }> = await this.db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.userId, userId));
    const slug = uniquifyProjectSlug(
      slugifyProjectName(data.name),
      existingSlugRows
        .map((r) => r.slug)
        .filter((s): s is string => typeof s === "string" && s.length > 0)
    );

    let project: Project;
    try {
      const [inserted] = await this.db
        .insert(projects)
        .values({
          id: data.id,
          name: data.name,
          slug,
          description: data.description,
          status: data.status || "active",
          settings: data.settings || {},
          metadata,
          userId,
          workspaceId: data.workspaceId ?? null,
        })
        .returning();
      project = inserted;
    } catch (err: unknown) {
      // TOCTOU race: two concurrent creates of the same name both pass the
      // dedup SELECT, compute the same slug, and the loser hits the partial
      // unique index (user_id, slug) — Postgres 23505. Resolve it the way the
      // dedup door would have: re-read and return the winner as `deduped`.
      const pgCode = err as { code?: string; cause?: { code?: string } };
      if (pgCode?.code === "23505" || pgCode?.cause?.code === "23505") {
        const retry = await findProjectDedupCandidates(this.db, {
          userId,
          name: data.name,
        });
        if (retry.exact) {
          const [winner] = await this.db
            .select()
            .from(projects)
            .where(eq(projects.id, retry.exact.id));
          if (winner) return { ...winner, deduped: true };
        }
      }
      throw err;
    }

    await this.emitCompleted("create", project, userId);
    // Announce to the CP project directory (fire-and-forget; W1).
    triggerCpProjectSync();
    return match.near.length > 0
      ? { ...project, dedupCandidates: match.near }
      : project;
  }

  /**
   * Update an existing project
   * Emits: projects.update.completed
   */
  async update(
    id: string,
    data: UpdateProjectInput,
    userId: string
  ): Promise<Project> {
    const [project] = await this.db
      .update(projects)
      .set({
        name: data.name,
        description: data.description,
        status: data.status,
        settings: data.settings,
        metadata: data.metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();

    if (!project) {
      throw new Error("Project not found");
    }

    await this.emitCompleted("update", project, userId);
    // Announce to the CP project directory (fire-and-forget; W1).
    triggerCpProjectSync();
    return project;
  }

  /**
   * Delete a project
   * Emits: projects.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    // Ownership is not re-checked here — the caller (tRPC router) gates via
    // checkPermissionOrPropose. Workspace members may delete projects they
    // did not create if the RBAC policy allows it.
    const result = await this.db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });

    if (result.length === 0) {
      throw new Error("Project not found");
    }

    await this.emitCompleted(
      "delete",
      { id } as Partial<Project> & { id: string },
      userId
    );
    // Announce to the CP project directory (fire-and-forget; W1). Projects are
    // hard-deleted, so the full-list push lets the CP tombstone the row.
    triggerCpProjectSync();
  }
}
