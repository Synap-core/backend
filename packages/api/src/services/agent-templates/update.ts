/**
 * The governed write of ONE installed agent template (`agent_templates`): the
 * door a package update reaches it through (`reconcile-standalone-configs-
 * to-templates.ts`, kind `agent`: the start-up pass, the person's apply, Undo,
 * "Stop updates"), and what approving an agent's write replays
 * (`agentTemplate/update`, `routers/proposals/executors/package-update.ts`).
 *
 * In order, nothing written until the end:
 *  1. `wake.program` never changes here: the program a computer runs on
 *     handed work is not changed remotely. Refused, with the field named.
 *  2. When a field changes, the template as it would be after the write is
 *     read again by `parseAgentTemplateSpec`, the rule install applies: a
 *     malformed update is refused.
 *  3. `checkPermissionOrPropose` (`agentTemplate/update`). A change of `wake`
 *     or `harness` is a person's: an agent's write of one always proposes.
 *  4. One UPDATE of the changed columns; `metadata` is shallow-merged onto
 *     the row's bag, as the other kinds' update doors do.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, getActingAgentUserId } from "@synap/database";
import { agentTemplates } from "@synap/database/schema";
import { parseAgentTemplateSpec } from "@synap-core/types/agents";

import { deepEqual } from "../capabilities/market-source.js";
import type { WriteOutcome } from "../capabilities/reconcile-standalone-configs-to-templates.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import type { Context } from "../../types/context.js";

/** The columns install writes and baselines (`install.ts`). */
export const AGENT_TEMPLATE_FIELDS = [
  "name",
  "harness",
  "aliases",
  "worker",
  "tried",
  "detect",
  "wake",
  "practices",
  "toolProfile",
  "toolGroups",
] as const;

/** Changed only by a person: an agent's write of one always proposes. */
export const AGENT_TEMPLATE_PERSON_ONLY_FIELDS = ["wake", "harness"] as const;

/** The program a `wake` starts, or null when there is none. */
function programOf(wake: unknown): string | null {
  if (!wake || typeof wake !== "object") return null;
  const program = (wake as { program?: unknown }).program;
  return typeof program === "string" ? program : null;
}

/** The template as it would be after the write, read by install's rule. */
function assertValidAfter(name: string, next: Record<string, unknown>): void {
  if (typeof next.name !== "string" || next.name.trim() === "") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The update of the agent template "${name}" is refused: it needs a name. Nothing was written.`,
    });
  }
  const parsed = parseAgentTemplateSpec({
    harness: next.harness,
    aliases: next.aliases,
    worker: next.worker,
    tried: next.tried,
    // Stored as null when absent; the parser reads an absent field.
    detect: next.detect ?? undefined,
    wake: next.wake ?? undefined,
    practices: next.practices,
    toolProfile: next.toolProfile ?? undefined,
    toolGroups: next.toolGroups ?? undefined,
  });
  if (!parsed.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The update of the agent template "${name}" is refused: ${parsed.reason}. Nothing was written.`,
    });
  }
}

export async function updateAgentTemplate(
  ctx: Context,
  input: {
    id: string;
    /** Column values; a key that is not a template field is ignored. */
    fields?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    /** The acting agent when the caller has no request scope. */
    agentUserId?: string;
  }
): Promise<WriteOutcome> {
  const userId = ctx.userId;
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Changing an agent template needs a signed-in person or key.",
    });
  }
  const [row] = await db
    .select()
    .from(agentTemplates)
    .where(eq(agentTemplates.id, input.id))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No such agent template on this pod.",
    });
  }

  const live = row as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of AGENT_TEMPLATE_FIELDS) {
    if (
      input.fields &&
      k in input.fields &&
      !deepEqual(input.fields[k], live[k])
    )
      patch[k] = input.fields[k];
  }
  const changed = Object.keys(patch);

  if ("wake" in patch && programOf(patch.wake) !== programOf(row.wake)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `An update never changes the program a computer runs for "${row.name}" (wake.program ${programOf(row.wake) ?? "none"} → ${programOf(patch.wake) ?? "none"}). Nothing was written. Keep this pod's value for "wake" (choose "mine").`,
    });
  }

  if (changed.length > 0) assertValidAfter(row.name, { ...live, ...patch });
  if (changed.length === 0 && !input.metadata) return { status: "updated" };

  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId:
      getActingAgentUserId() ??
      input.agentUserId ??
      ctx.agentUserId ??
      undefined,
    subjectType: "agentTemplate",
    action: "update",
    forcePropose: changed.some((k) =>
      (AGENT_TEMPLATE_PERSON_ONLY_FIELDS as readonly string[]).includes(k)
    ),
    data: {
      id: row.id,
      ...patch,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }

  await db
    .update(agentTemplates)
    .set({
      ...(patch as Partial<typeof agentTemplates.$inferInsert>),
      ...(input.metadata
        ? { metadata: { ...(row.metadata ?? {}), ...input.metadata } }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentTemplates.id, row.id));
  return { status: "updated" };
}
