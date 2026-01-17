/**
 * Project Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface Project {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string;
  createdBy: string;
  status: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ProjectIndexer extends BaseIndexer<Project> {
  collectionName = "projects";

  async toSearchDocument(project: Project): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: project.id,
      name: project.name,
      description: project.description || undefined,
      userId: project.createdBy,
      workspaceId: project.workspaceId,
      status: project.status || undefined,
      createdAt: this.toTimestamp(project.createdAt),
      updatedAt: this.toTimestamp(project.updatedAt),
      memberCount: 0, // TODO: Count from project_members
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
