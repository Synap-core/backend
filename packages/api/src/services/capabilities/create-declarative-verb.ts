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

import { and, eq, isNull, or, type SQL } from "@synap/database";
import { tools as toolsTable } from "@synap/database/schema";
import type { ProviderVerbSpec } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import type { CreateVerbInput } from "../../routers/mcp/validate-create-verb.js";

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
    ...(input.query ? { query: input.query } : {}),
    ...(input.body ? { body: input.body } : {}),
    ...(input.responseShape ? { responseShape: input.responseShape } : {}),
  };
}
