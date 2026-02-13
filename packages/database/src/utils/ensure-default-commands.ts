/**
 * Ensure Default Commands (Default Command Pack v1)
 *
 * Seeds workspace-scoped intelligence commands when a new workspace is created.
 * Same pattern as ensureDefaultViews.
 *
 * MVP commands (Default Command Pack v1 — subset):
 * - Create view from description
 * - Extract entities from text
 * - Summarize selection
 * - Analyze entities
 * - Create task from text
 * - Create event from text
 *
 * Located in @synap/database to avoid circular dependencies.
 */

import { getDb } from "../client-pg.js";
import { intelligenceCommands, workspaces } from "../schema/index.js";
import type { DerivedInput } from "../schema/intelligence-commands.js";
import { eq } from "drizzle-orm";

export interface EnsureDefaultCommandsResult {
  status: "created" | "skipped" | "error";
  message: string;
  commandsCreated: number;
  commandIds?: string[];
  error?: string;
}

/** One default command definition (prompt template + metadata). */
interface DefaultCommandDef {
  title: string;
  promptTemplate: string;
  derivedInputs: DerivedInput[];
  outputMode: "text" | "proposal" | "view";
  canCreateViews: boolean;
  permissionsProfile: "read_only" | "propose_writes";
}

const DEFAULT_COMMANDS: DefaultCommandDef[] = [
  {
    title: "Create View from Description",
    promptTemplate: `You are helping the user create a new view from a natural language description.

**User's goal:** {argument name="Goal"}

Create a proposal for a new view that matches this description. Include:
- View type (table, kanban, list, etc.)
- Filters, sorts, and scope
- Layout configuration

Output your proposal clearly so it can be turned into a Synap view.`,
    derivedInputs: [{ name: "Goal", label: "Goal", type: "string" }],
    outputMode: "view",
    canCreateViews: true,
    permissionsProfile: "propose_writes",
  },
  {
    title: "Extract Entities from Text",
    promptTemplate: `You are helping the user extract entities and relationships from text.

**User's selection (text, doc snippets, or notes):**

{selection}

Analyze this content and propose:
1. New entities to create (Notes, Tasks, People, Companies, etc.) with their properties
2. Relationships between entities (blocks, related_to, parent_of, etc.)

Output proposals that the user can review and approve. Do not create anything directly—always propose.`,
    derivedInputs: [],
    outputMode: "proposal",
    canCreateViews: false,
    permissionsProfile: "propose_writes",
  },
  {
    title: "Summarize Selection",
    promptTemplate: `You are helping the user get a concise summary of their selection.

**User's selection:**

{selection}

Provide a clear, structured summary. Highlight key points, dates, and actionable items if relevant. Keep it concise but comprehensive.`,
    derivedInputs: [],
    outputMode: "text",
    canCreateViews: false,
    permissionsProfile: "read_only",
  },
  {
    title: "Analyze Entities",
    promptTemplate: `You are helping the user analyze selected entities.

**Selected entities context:**

{selection}

Analyze these entities and provide:
- Overview and patterns
- Insights, gaps, or opportunities
- Suggestions for relationships or next steps

Be concise and actionable.`,
    derivedInputs: [],
    outputMode: "text",
    canCreateViews: false,
    permissionsProfile: "read_only",
  },
  {
    title: "Create Task from Text",
    promptTemplate: `You are helping the user turn text into tasks.

**User's text (meeting notes, pasted content, or selection):**

{selection}

Extract actionable tasks. For each task propose:
- Title
- Optional: due date, priority, assignee, status
- Link to source if applicable

Output proposals only—do not create entities directly. The user will review and approve.`,
    derivedInputs: [],
    outputMode: "proposal",
    canCreateViews: false,
    permissionsProfile: "propose_writes",
  },
  {
    title: "Create Event from Text",
    promptTemplate: `You are helping the user turn text into events.

**User's text (meeting notes, calendar copy, or selection):**

{selection}

Extract events with dates/times. For each event propose:
- Title
- Start time and end time
- Optional: description, tags

Output proposals only—do not create entities directly. The user will review and approve.`,
    derivedInputs: [],
    outputMode: "proposal",
    canCreateViews: false,
    permissionsProfile: "propose_writes",
  },
];

/**
 * Create default commands for a workspace if they don't exist
 *
 * @param workspaceId - The workspace ID
 * @param userId - The user ID (workspace owner or member)
 * @returns Result indicating if commands were created or skipped
 */
export async function ensureDefaultCommands(
  workspaceId: string,
  userId: string
): Promise<EnsureDefaultCommandsResult> {
  const db = await getDb();

  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    if (!workspace) {
      return {
        status: "error",
        message: `Workspace ${workspaceId} not found`,
        commandsCreated: 0,
        error: "WORKSPACE_NOT_FOUND",
      };
    }

    const existing = await db.query.intelligenceCommands.findMany({
      where: eq(intelligenceCommands.workspaceId, workspaceId),
    });

    const existingTitles = new Set(existing.map((c) => c.title));
    const toCreate = DEFAULT_COMMANDS.filter(
      (d) => !existingTitles.has(d.title)
    );

    if (toCreate.length === 0) {
      return {
        status: "skipped",
        message: "Default commands already exist",
        commandsCreated: 0,
        commandIds: existing.map((c) => c.id),
      };
    }

    const createdIds: string[] = [];

    for (const def of toCreate) {
      const [row] = await db
        .insert(intelligenceCommands)
        .values({
          workspaceId,
          createdBy: userId,
          title: def.title,
          promptTemplate: def.promptTemplate,
          compiledTemplateAst: null,
          derivedInputs: def.derivedInputs,
          inputOverrides: undefined,
          allowedTools: undefined,
          allowedEntityTypes: undefined,
          maxEntitiesCreatedPerRun: undefined,
          canCreateViews: def.canCreateViews,
          outputMode: def.outputMode,
          permissionsProfile: def.permissionsProfile,
          sharedScope: "workspace",
        })
        .returning({ id: intelligenceCommands.id });

      if (row) createdIds.push(row.id);
    }

    return {
      status: "created",
      message: `Created ${createdIds.length} default command(s)`,
      commandsCreated: createdIds.length,
      commandIds: createdIds,
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(
      `[ensureDefaultCommands] Error creating default commands for workspace ${workspaceId}:`,
      { error: err.message, stack: err.stack }
    );
    return {
      status: "error",
      message: `Failed to create default commands: ${err.message}`,
      commandsCreated: 0,
      error: err.message,
    };
  }
}
