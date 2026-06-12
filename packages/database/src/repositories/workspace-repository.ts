/**
 * Workspace Repository
 *
 * Handles all workspace CRUD operations with automatic event emission
 */

import { eq, sql, inArray, or, type SQL } from "drizzle-orm";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import { entities } from "../schema/entities.js";
import { relations } from "../schema/relations.js";
import { proposals } from "../schema/proposals.js";
import { documents, documentVersions } from "../schema/documents.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Workspace, NewWorkspace } from "../schema/workspaces.js";

export interface PurgeWorkspaceResult {
  entityIds: string[];
  documentIds: string[];
  /** MinIO storage keys to delete AFTER the transaction commits. */
  storageKeys: string[];
  relationsDeleted: number;
  proposalsDeleted: number;
}

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  ownerId: string;
  settings?: Record<string, unknown>;
}

export interface UpdateWorkspaceInput {
  name?: string;
  settings?: Record<string, unknown>;
}

export class WorkspaceRepository extends BaseRepository<
  Workspace,
  CreateWorkspaceInput,
  UpdateWorkspaceInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "workspaces" });
  }

  /**
   * Create a new workspace
   * Emits: workspaces.create.completed
   */
  async create(data: CreateWorkspaceInput, userId: string): Promise<Workspace> {
    const s = (data.settings ?? {}) as WorkspaceSettings;
    const [workspace] = await this.db
      .insert(workspaces)
      .values({
        id: data.id,
        name: data.name,
        ownerId: data.ownerId,
        settings: data.settings || {},
        // Dual-write promoted columns (0039) from the settings blob.
        systemSlug: s.systemSlug ?? null,
        packageSlug: s.packageSlug ?? null,
        provisioningProposalId: s.proposalId ?? null,
        provisioningStatus: s.provisioningStatus ?? null,
      } as NewWorkspace)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", workspace, userId);

    return workspace;
  }

  /**
   * Update an existing workspace
   * Emits: workspaces.update.completed
   */
  async update(
    id: string,
    data: UpdateWorkspaceInput,
    userId: string
  ): Promise<Workspace> {
    const s = data.settings as WorkspaceSettings | undefined;
    const [workspace] = await this.db
      .update(workspaces)
      .set({
        name: data.name,
        settings: data.settings,
        // When settings is fully replaced, keep the promoted columns (0039) in sync.
        ...(s
          ? {
              systemSlug: s.systemSlug ?? null,
              packageSlug: s.packageSlug ?? null,
              provisioningProposalId: s.proposalId ?? null,
              provisioningStatus: s.provisioningStatus ?? null,
            }
          : {}),
        updatedAt: new Date(),
      } as Partial<NewWorkspace>)
      .where(eq(workspaces.id, id))
      .returning();

    if (!workspace) {
      throw new Error("Workspace not found");
    }

    // Emit completed event
    await this.emitCompleted("update", workspace, userId);

    return workspace;
  }

  /**
   * Shallow-merge a partial settings object into the workspace's existing settings.
   * Uses Postgres `||` JSONB operator — atomic, no read-then-write needed.
   * Top-level keys in `patch` overwrite the corresponding keys in settings.
   * Keys not present in `patch` are preserved unchanged.
   *
   * For nested merges (e.g. updating one key inside profileBentoViewIds) the
   * caller should build the merged sub-object and pass it as a single key:
   *   mergeSettings(id, { profileBentoViewIds: { ...existing, deal: viewId } }, userId)
   */
  async mergeSettings(
    id: string,
    patch: Partial<WorkspaceSettings>,
    userId: string
  ): Promise<Workspace> {
    const [workspace] = await this.db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || ${JSON.stringify(patch)}::jsonb`,
        // Lift promoted keys (0039) into their real columns when the patch sets
        // them — keeps columns in sync through the atomic JSONB merge path
        // (the provisioning-status transitions flow only through here).
        ...(patch.systemSlug !== undefined
          ? { systemSlug: patch.systemSlug }
          : {}),
        ...(patch.packageSlug !== undefined
          ? { packageSlug: patch.packageSlug }
          : {}),
        ...(patch.proposalId !== undefined
          ? { provisioningProposalId: patch.proposalId }
          : {}),
        ...(patch.provisioningStatus !== undefined
          ? { provisioningStatus: patch.provisioningStatus }
          : {}),
        updatedAt: new Date(),
      } as Partial<NewWorkspace>)
      .where(eq(workspaces.id, id))
      .returning();

    if (!workspace) {
      throw new Error("Workspace not found");
    }

    await this.emitCompleted("update", workspace, userId);
    return workspace;
  }

  /**
   * Purge all WORKSPACE-SCOPED content for a workspace, in one transaction.
   *
   * Deletes only rows pinned to this workspace (`workspaceId = id`) plus the
   * relations/documents that hang off those entities — NEVER pod-wide rows
   * (`workspaceId IS NULL`), which belong to the data pod and may be shared by
   * other workspaces. FK-safe order: relations → proposals → entities →
   * documents (entities reference documents via `documentId`).
   *
   * Config tables (views, profiles, property_defs, relation_defs, members,
   * invites) already FK-cascade when the `workspaces` row is deleted, so they
   * are NOT touched here.
   *
   * Returns the collected entity/document ids + MinIO storage keys so the
   * caller can clean MinIO blobs + the Typesense index AFTER the tx commits.
   */
  async purgeWorkspaceData(workspaceId: string): Promise<PurgeWorkspaceResult> {
    return this.db.transaction(async (tx: any) => {
      // Workspace-scoped entities + the documents they link to.
      const ents: Array<{ id: string; documentId: string | null }> = await tx
        .select({ id: entities.id, documentId: entities.documentId })
        .from(entities)
        .where(eq(entities.workspaceId, workspaceId));
      const entityIds = ents.map((e) => e.id);

      // Documents owned by the workspace + documents linked from those entities.
      const wsDocs: Array<{ id: string; storageKey: string | null }> = await tx
        .select({ id: documents.id, storageKey: documents.storageKey })
        .from(documents)
        .where(eq(documents.workspaceId, workspaceId));
      const linkedDocIds = ents
        .map((e) => e.documentId)
        .filter((d): d is string => !!d);
      const missingLinked = linkedDocIds.filter(
        (id) => !wsDocs.some((d) => d.id === id)
      );
      let linkedDocs: Array<{ id: string; storageKey: string | null }> = [];
      if (missingLinked.length) {
        linkedDocs = await tx
          .select({ id: documents.id, storageKey: documents.storageKey })
          .from(documents)
          .where(inArray(documents.id, missingLinked));
      }
      const allDocs = [...wsDocs, ...linkedDocs];
      const documentIds = Array.from(new Set(allDocs.map((d) => d.id)));
      const documentStorageKeys = allDocs
        .map((d) => d.storageKey)
        .filter((k): k is string => !!k);
      const versionStorageKeys = documentIds.length
        ? (
            await tx
              .select({ storageKey: documentVersions.storageKey })
              .from(documentVersions)
              .where(inArray(documentVersions.documentId, documentIds))
          )
            .map((d: { storageKey: string | null }) => d.storageKey)
            .filter((k: string | null): k is string => !!k)
        : [];
      const storageKeys = Array.from(
        new Set([...documentStorageKeys, ...versionStorageKeys])
      );

      // 1) relations — workspace-scoped OR touching a workspace entity.
      const relConds: SQL[] = [eq(relations.workspaceId, workspaceId)];
      if (entityIds.length) {
        relConds.push(inArray(relations.sourceEntityId, entityIds));
        relConds.push(inArray(relations.targetEntityId, entityIds));
      }
      const delRels = await tx
        .delete(relations)
        .where(relConds.length === 1 ? relConds[0] : or(...relConds))
        .returning({ id: relations.id });

      // 2) proposals (workspaceId column is text).
      const delProps = await tx
        .delete(proposals)
        .where(eq(proposals.workspaceId, workspaceId))
        .returning({ id: proposals.id });

      // 3) entities (cascades entity_vectors + entity_property_index off id).
      if (entityIds.length) {
        await tx.delete(entities).where(inArray(entities.id, entityIds));
      }

      // 4) documents (now unreferenced by any entity).
      if (documentIds.length) {
        await tx.delete(documents).where(inArray(documents.id, documentIds));
      }

      return {
        entityIds,
        documentIds,
        storageKeys,
        relationsDeleted: delRels.length,
        proposalsDeleted: delProps.length,
      };
    });
  }

  /**
   * Delete a workspace
   * Emits: workspaces.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(workspaces)
      .where(eq(workspaces.id, id))
      .returning({ id: workspaces.id });

    if (result.length === 0) {
      throw new Error("Workspace not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
