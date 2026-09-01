/**
 * Declarative-verb creation — the shared, DB-free pieces.
 *
 * `synap_create_verb` (MCP, `routers/mcp/adapter.ts`) and
 * `capabilities.registry.createVerb` (tRPC, the human/UI door) are the SAME
 * three steps:
 *
 *   1. `validateCreateVerbInput` — pure, unit-tested (`validate-create-verb.ts`);
 *   2. resolve the PARENT TOOL — a verb can only be added to an already-installed,
 *      caller-visible tool. Its predicate + its error wording live HERE;
 *   3. hand the built `ProviderVerbSpec` to `skillsRouter.create` — the ONE
 *      governed door (`checkPermissionOrPropose` runs inside it).
 *
 * Step 2's predicate/message and step 3's spec assembly are extracted so the two
 * doors cannot drift: the precondition that decides whether a verb may exist at
 * all must be one implementation, not two. Everything here is pure (no I/O), so
 * it is unit-testable without the DB — the caller runs the one-line drizzle
 * query with `parentToolWhere()`.
 *
 * (The MCP adapter still carries its own inline copy of step 2 — repointing it
 * is a follow-up in that file's owning wave; this file is the target.)
 */

import { getDb, and, eq, isNull, or, type SQL } from "@synap/database";
import { tools as toolsTable, links } from "@synap/database/schema";
import type {
  ProviderVerbSpec,
  ToolVerbCatalogEntry,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import type { CreateVerbInput } from "../../routers/mcp/validate-create-verb.js";
import { upsertVerbCatalogEntry } from "./verb-catalog.js";
import { skillsRouter } from "../../routers/skills.js";
import { capabilityContainersRouter } from "../../routers/capability-containers.js";
import {
  deriveVerbKind,
  GRANT_DEFAULT_EXEC_MODE,
} from "./create-from-definition.js";

const logger = createLogger({ module: "create-declarative-verb" });

/**
 * The `tools` predicate selecting the parent tool a new declarative verb may
 * attach to.
 *
 * Visibility: pod-wide rows always; the given workspace's rows only when a
 * workspace lens is supplied — and then `userVisibleWhere` is re-ANDed ON TOP of
 * the lens, never instead of it (a lens alone is owner-blind).
 *
 * NOTE the caller must ALSO have authorized `workspaceId` (membership) before
 * building this predicate: the lens narrows, it does not authorize.
 */
export function parentToolWhere(args: {
  userId: string;
  toolName: string;
  workspaceId?: string | null;
}): SQL {
  const { userId, toolName, workspaceId } = args;
  const wsLens = workspaceId
    ? or(
        isNull(toolsTable.workspaceId),
        eq(toolsTable.workspaceId, workspaceId)
      )
    : isNull(toolsTable.workspaceId);

  return and(
    eq(toolsTable.name, toolName),
    wsLens,
    userVisibleWhere(toolsTable.workspaceId, userId)
  )!;
}

/**
 * The one wording for the missing-parent-tool precondition, so the MCP error
 * string and the tRPC error message stay identical.
 *
 * This is a real, actionable PRECONDITION, not an internal failure: this door
 * only ADDS a verb to an existing tool — it never creates a tool or a connection
 * as a side effect. The message names the tool, the lens, and the two ways
 * forward (install/connect it, or check the exact name in the catalogue) so a UI
 * can surface "pick the tool this verb belongs to" up front.
 */
export function parentToolMissingMessage(
  toolName: string,
  workspaceId?: string | null
): string {
  return (
    `Tool '${toolName}' is not installed` +
    `${workspaceId ? ` for workspace ${workspaceId}` : ""}. ` +
    `A verb can only be added to an ALREADY-installed, credentialed tool — ` +
    `install/connect '${toolName}' first, or check the exact name in the capability catalogue.`
  );
}

/**
 * Assemble the canonical `ProviderVerbSpec` from validated input.
 *
 * Reuses the schema's field names verbatim (`@synap/database` schema/skills.ts)
 * — no invented keys — and carries `responseShape` through, which is what the
 * executor applies (`execute-provider-verb.ts`) and what the registry now
 * projects back as the verb's output contract.
 */
export function buildProviderVerbSpec(
  input: CreateVerbInput
): ProviderVerbSpec {
  return {
    tool: input.toolName,
    method: input.method,
    pathTemplate: input.pathTemplate,
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.graphql ? { graphql: input.graphql } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.body ? { body: input.body } : {}),
    ...(input.responseShape ? { responseShape: input.responseShape } : {}),
  };
}

/** Which read paths the newly-created verb was wired into. */
export interface WireCreatedVerbResult {
  /** `skill --requires--> tool` edge written. */
  requires: boolean;
  /** Appended to the parent tool's `tools.capabilities` verb catalogue. */
  catalogued: boolean;
  /** Capability containers the verb joined as a `skill` member. */
  capabilityIds: string[];
}

/**
 * WIRE a just-created declarative verb into every read path that surfaces it.
 *
 * `skillsRouter.create` inserts a BARE skill row and writes no links, so without
 * this a verb is born ORPHANED — invisible under its tool, on its capability
 * card, and in the Bricks registry catalogue. This is the SHARED step 4 for BOTH
 * doors (tRPC `capabilities.createVerb` and MCP `synap_create_verb`); keeping it
 * here is what stops the two from drifting (the MCP door wrote NONE of these
 * edges — its verbs were permanently orphaned).
 *
 * Every edge goes through its EXISTING door (`setRequiredTools`, `addPart`, the
 * catalogue upsert) — never a hand-inserted link. Failures are REPORTED, not
 * thrown: the skill row already exists and `skills.create` is not idempotent, so
 * raising here would push a caller into re-creating a duplicate verb. Call ONLY
 * on a `created` result — a `proposed` skill row does not exist yet, so there is
 * nothing to link to (the wiring for an approved proposal happens where the
 * proposal materializes the skill).
 *
 * `ctx` MUST be the same governed caller context used for `skills.create` (its
 * resolved workspace lens) — `setRequiredTools`/`addPart` authorize against it.
 */
export async function wireCreatedVerb(
  ctx: Parameters<typeof skillsRouter.createCaller>[0],
  args: {
    skillId: string;
    parentToolId: string;
    verbName: string;
    description?: string;
    parameters?: unknown;
  }
): Promise<WireCreatedVerbResult> {
  const { skillId, parentToolId, verbName, description, parameters } = args;
  const wiring: WireCreatedVerbResult = {
    requires: false,
    catalogued: false,
    capabilityIds: [],
  };
  const database = await getDb();

  // 1. `skill --requires--> tool` — the parent edge.
  const skillsCaller = skillsRouter.createCaller(ctx);
  try {
    await skillsCaller.setRequiredTools({ skillId, toolIds: [parentToolId] });
    wiring.requires = true;
  } catch (err) {
    logger.error(
      { skillId, toolId: parentToolId, err },
      "wireCreatedVerb: failed to write the requires edge"
    );
  }

  // 2. `skill --member_of--> capability` for each container the parent tool
  //    belongs to. A tool in no container is normal (a bare connect) — nothing
  //    to join. `addPart` refuses a container the caller may see but not write
  //    (pod-wide not owned / non-member workspace); the verb is still created.
  try {
    const containerLinks = await database
      .select({ capabilityId: links.toId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "tool"),
          eq(links.fromId, parentToolId),
          eq(links.toType, "capability"),
          eq(links.linkType, "member_of")
        )
      );
    const containersCaller = capabilityContainersRouter.createCaller(
      ctx as never
    );
    for (const capabilityId of new Set(
      containerLinks.map((l) => l.capabilityId)
    )) {
      try {
        await containersCaller.addPart({
          capabilityId,
          partType: "skill",
          partId: skillId,
        });
        wiring.capabilityIds.push(capabilityId);
      } catch (err) {
        logger.warn(
          { capabilityId, skillId, err },
          "wireCreatedVerb: could not attach verb to capability"
        );
      }
    }
  } catch (err) {
    logger.error(
      { toolId: parentToolId, err },
      "wireCreatedVerb: capability-container lookup failed"
    );
  }

  // 3. Append to the parent tool's verb catalogue, in the SAME shape
  //    `deriveToolVerbs` produces. Row-locked read-modify-write on the jsonb
  //    array so concurrent createVerb calls on the same tool are additive, not
  //    last-writer-wins. Idempotent by verb id via `upsertVerbCatalogEntry`.
  try {
    await database.transaction(async (tx) => {
      const [toolRow] = await tx
        .select({ capabilities: toolsTable.capabilities })
        .from(toolsTable)
        .where(eq(toolsTable.id, parentToolId))
        .for("update")
        .limit(1);
      const entry: ToolVerbCatalogEntry = {
        id: verbName,
        label: verbName,
        kind: deriveVerbKind({
          name: verbName,
          ...(description ? { description } : {}),
        }),
        ...(parameters && typeof parameters === "object"
          ? { argsSchema: parameters as Record<string, unknown> }
          : {}),
        govDefault: GRANT_DEFAULT_EXEC_MODE,
      };
      await tx
        .update(toolsTable)
        .set({
          capabilities: upsertVerbCatalogEntry(
            toolRow?.capabilities ?? [],
            entry
          ),
          updatedAt: new Date(),
        })
        .where(eq(toolsTable.id, parentToolId));
    });
    wiring.catalogued = true;
  } catch (err) {
    logger.error(
      { toolId: parentToolId, verbName, err },
      "wireCreatedVerb: failed to append the verb catalogue entry"
    );
  }

  return wiring;
}
