/**
 * projectToSuitePackageDefinition — project uses-edges → suite PackageDefinition.
 * =================================================================================
 *
 * Pod-native door for `synap market publish --from-project <id>`:
 *   1. Load the project (caller already gated visibility).
 *   2. Walk `listWorkspacesUsedByProject` (the uses-edge INDEX).
 *   3. Serialise each workspace via `workspaceToPackageDefinition` (lossy —
 *      same drop-list as `--from-workspace`).
 *   4. Compose ONE suite package via `composeSuitePackageDefinition`
 *      (`suite` tag, `require` deps, embedded playbooks).
 *
 * READ-ONLY. Does not publish — the CLI posts the result to `POST /api/packages`.
 */

import {
  getDb,
  projects,
  and,
  eq,
  ownerPrivateVisibleWhere,
  type PackageDefinition,
} from "@synap/database";
import { listWorkspacesUsedByProject } from "../utils/project-workspace.js";
import { workspaceToPackageDefinition } from "./workspace-to-package-definition.js";
import { composeSuitePackageDefinition } from "./compose-suite-package-definition.js";

export interface ProjectToSuitePackageDefinitionResult {
  definition: PackageDefinition;
  projectId: string;
  projectName: string;
  /** Workspace ids that were serialised into the suite. */
  workspaceIds: string[];
  /** Workspace package slugs the suite `require`s. */
  requiredSlugs: string[];
}

/**
 * Serialize a live project into a suite `PackageDefinition`.
 * Throws if the project is missing/invisible, uses no workspaces, or a
 * constituent workspace cannot be serialised.
 */
export async function projectToSuitePackageDefinition(opts: {
  projectId: string;
  userId: string;
}): Promise<ProjectToSuitePackageDefinitionResult> {
  const { projectId, userId } = opts;
  const dbConn = await getDb();

  const [project] = await dbConn
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
    })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)
      )
    )
    .limit(1);

  if (!project) {
    throw new Error(`project ${projectId} not found or not visible`);
  }

  const workspaceIds = await listWorkspacesUsedByProject(userId, projectId);
  if (workspaceIds.length === 0) {
    throw new Error(
      `project ${projectId} ("${project.name}") uses no workspaces — link domains with uses-edges before publishing a suite`
    );
  }

  const workspaceDefs: PackageDefinition[] = [];
  for (const workspaceId of workspaceIds) {
    workspaceDefs.push(
      await workspaceToPackageDefinition({ workspaceId, userId })
    );
  }

  const definition = composeSuitePackageDefinition({
    projectName: project.name,
    projectDescription: project.description,
    workspaceDefs,
  });

  return {
    definition,
    projectId: project.id,
    projectName: project.name,
    workspaceIds,
    requiredSlugs: (definition.dependencies ?? []).map((d) => d.slug),
  };
}
