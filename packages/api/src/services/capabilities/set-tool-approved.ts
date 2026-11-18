/**
 * ONE body for turning a tool's execution approval on or off, after the door
 * has decided who may ask (`tools.setApproved`: the proof of presence for an
 * ON, the agent refusal; `capabilities.enableMany`: one proof for a set).
 * Owner-gated: a workspace tool needs the workspace OWNER, a pod-wide
 * (null-workspace) tool pod admin. An unapproved tool is refused by the
 * dispatcher (`external-dispatch.ts`).
 */
import { TRPCError } from "@trpc/server";
import { db, eq, tools } from "@synap/database";
import type { Tool } from "@synap/database/schema";
import { getWorkspaceRole, requirePodAdmin } from "../../utils/workspace-role.js";
import { isFormToolMetadata } from "../forms/form-definition.js";

/**
 * A PUBLIC FORM is a `tools` row whose `metadata.form` holds its definition,
 * token hash and actor (Sites W4). `update` below edits metadata with NO
 * governance check (the config-only carve-out), so a generic door could swap a
 * form's kind, actor or token hash. Every mutating door here refuses a form
 * row — and refuses to CREATE one — the forms door
 * (`services/forms/form-service.ts`) is its only writer.
 */
export function refuseFormRow(metadata: unknown): void {
  if (isFormToolMetadata(metadata)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This tool is a public form. Manage it through the forms door (forms.*), not the generic tool doors.",
    });
  }
}

export async function setToolApproved(input: {
  userId: string;
  toolId: string;
  approved: boolean;
}): Promise<Tool> {
  const existing = await db.query.tools.findFirst({
    where: eq(tools.id, input.toolId),
  });
  if (!existing)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Tool ${input.toolId} not found`,
    });
  refuseFormRow(existing.metadata);
  if (existing.workspaceId) {
    const role = await getWorkspaceRole(input.userId, existing.workspaceId);
    if (role !== "owner") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only workspace owners can approve tool execution.",
      });
    }
  } else {
    // Pod-wide (null-workspace) tool — pod-level privileged action.
    await requirePodAdmin(input.userId);
  }

  const [tool] = await db
    .update(tools)
    .set({ approved: input.approved, updatedAt: new Date() })
    .where(eq(tools.id, input.toolId))
    .returning();
  return tool as Tool;
}
