/**
 * updateFocusSession — shared service behind the MCP `synap_update_session` tool.
 *
 * Mirrors createFocusSession / completeFocusSession: owns the load, governance
 * gate, the read-modify-write of the JSONB `expectedOutputs` array (row-locked
 * transaction to avoid TOCTOU), and the `stage_changed` side-effect. Extracted
 * verbatim from the MCP adapter so the tool handler just delegates + shapes the
 * response.
 *
 * NOTE: this is the MCP door's field set (goal/status(active|paused)/progress/
 * currentStage + addOutput/completeOutput/expectedOutputs + addAgentId). The Hub REST PATCH
 * /focus-sessions/:id supports a wider set (channelId, correlationId, agentIds,
 * verificationReport, metadata, status=closed, realtime event) WITHOUT the
 * output RMW lock — they are intentionally distinct doors, not unified here.
 */

import { z } from "zod";
import { db, focusSessions, eq, and } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";

export interface UpdateFocusSessionParams {
  sessionId: string;
  /** Operator userId — the scoping floor (stops touching another user's session). */
  userId: string;
  agentUserId?: string;
  goal?: string;
  status?: "active" | "paused";
  progress?: number;
  currentStage?: string;
  addOutput?: { kind: string; label: string; icon?: string };
  completeOutput?: string;
  /**
   * APPEND one agent to the session roster. Mirrors `addOutput`: incremental
   * and idempotent, as against the wholesale `agentIds` assignment the tRPC and
   * Hub PATCH doors expose. Applied through the ONE append door,
   * `attachSessionAgent` — never by assigning `set.agentIds` here.
   */
  addAgentId?: string;
  expectedOutputs?: ExpectedOutput[];
}

export type UpdateFocusSessionResult =
  | { status: "not_found" }
  | { status: "denied"; reason: string }
  | {
      status: "proposed";
      proposalId: string;
      /**
       * Which proposed outcome this is: a CONTENT proposal, or a workspace-JOIN
       * gate filed INSTEAD of the write. Callers derive their sentence from it
       * (`proposedMessageFor`); without it on the TYPE the value cannot cross
       * this boundary and the door has to hardcode a claim it cannot check.
       */
      proposalType?: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | { status: "updated"; session: typeof focusSessions.$inferSelect };

type OutputItem = ExpectedOutput;

/**
 * The WIRE shape of one declared deliverable — the ONE input schema, imported by
 * every door that accepts an `expectedOutputs` array (tRPC `focusSessions`
 * create/update, Hub REST POST/PATCH /focus-sessions, this service via the MCP
 * handler).
 *
 * It exists because zod STRIPS what it does not declare. The narrow
 * `{kind,label,icon,status}` shape each door used to declare separately meant a
 * client echoing a slot back lost `delegatedTo`, `returnedReason` and
 * `satisfiedByProposalId` at the PARSE, before any merge could see them — the
 * fields were erased by the schema, not by the write. Declaring them here lets a
 * caller that genuinely holds the current slot round-trip it, and
 * {@link mergeExpectedOutputs} covers the caller that does not.
 *
 * Kept in lock-step with `ExpectedOutput` (@synap/playbooks) by the
 * `satisfies` below: a new field on the type is a compile error here until it is
 * either declared or deliberately left off the wire.
 */
export const expectedOutputWireSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  // Per-item lifecycle (defaults to "pending" when omitted). Shape-within-jsonb.
  status: z.enum(["pending", "done"]).optional(),
  claimedDone: z.boolean().optional(),
  satisfiedByProposalId: z.string().optional(),
  delegatedTo: z.string().optional(),
  delegatedAt: z.string().optional(),
  returnedReason: z.string().optional(),
  returnedAt: z.string().optional(),
}) satisfies z.ZodType<ExpectedOutput, ExpectedOutput>;

/**
 * The slot fields the SERVER owns — written by governance, delegation and
 * approval, never by whoever is patching the list.
 *
 * WHY A MERGE AT ALL. `expectedOutputs` is patched WHOLESALE by three doors
 * (this service, the tRPC `focusSessions.update`, the Hub REST PATCH), and the
 * surfaces that patch it — the browser session board above all — read the list,
 * edit one label, and send the whole array back. Every field they did not know
 * about was therefore ERASED on the next edit: a slot's delegation, its
 * reviewer's return note, and the approval lineage behind its `done` all
 * vanished because someone renamed a sibling. Widening the wire schema alone
 * does not fix that (a client written before the field still omits it); the
 * write has to CARRY FORWARD what it was not told about.
 *
 * The rule is: an incoming item that is SILENT about a server-owned field keeps
 * the stored value; one that carries the field explicitly wins. Silence is not
 * an instruction to delete.
 */
const SERVER_OWNED_OUTPUT_FIELDS = [
  "status",
  "claimedDone",
  "satisfiedByProposalId",
  "delegatedTo",
  "delegatedAt",
  "returnedReason",
  "returnedAt",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

/**
 * Merge an incoming `expectedOutputs` array onto the stored one BY LABEL — the
 * ONE merge, called by all three wholesale-update doors so they cannot drift
 * into three answers about what a patch destroys.
 *
 * Matching uses `normalizeExpectedLabel`, the same trim+casefold every other
 * slot lookup uses (delegation, return, satisfy). A label the stored array does
 * not carry is a NEW slot and lands verbatim; a stored slot the incoming array
 * omits is DELETED — that is the existing, deliberate semantic of a wholesale
 * assignment, and the merge does not change it.
 */
export function mergeExpectedOutputs(
  current: OutputItem[],
  incoming: OutputItem[]
): OutputItem[] {
  const stored = new Map<string, OutputItem>();
  for (const o of current) {
    const key = normalizeExpectedLabel(o?.label);
    // First wins: two slots sharing a label are already ambiguous everywhere
    // else (the delegation and satisfy doors both take the first match), so
    // this resolves it the same way rather than inventing a second answer.
    if (key && !stored.has(key)) stored.set(key, o);
  }

  return incoming.map((item) => {
    const key = normalizeExpectedLabel(item?.label);
    const prior = key ? stored.get(key) : undefined;
    if (!prior) return item;
    // Only the fields the incoming item is SILENT about are carried; an
    // explicit value (including one the caller genuinely round-tripped) wins.
    const carried: Partial<ExpectedOutput> = {};
    for (const field of SERVER_OWNED_OUTPUT_FIELDS) {
      if (item[field] !== undefined) continue;
      const value = prior[field];
      if (value !== undefined) {
        Object.assign(carried, { [field]: value });
      }
    }
    return { ...item, ...carried };
  });
}

export async function updateFocusSession(
  params: UpdateFocusSessionParams
): Promise<UpdateFocusSessionResult> {
  const { sessionId, userId, agentUserId } = params;

  // Load scoped by the operator userId — the floor that stops an agent key
  // from touching another user's session (mirrors completeFocusSession).
  const existing = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
  });
  if (!existing) {
    return { status: "not_found" };
  }

  // Governance membrane — AI callers route through proposals (same gate the
  // Hub PATCH /focus-sessions/:id and synap_complete_session use). Always carry
  // goal (for proposal summary / targetName) plus every intended mutation so
  // the focus_session/update executor can materialize the full patch on approve.
  const { checkPermissionOrPropose } =
    await import("../../utils/permission-check.js");
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: existing.workspaceId ?? undefined,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    data: {
      id: sessionId,
      // Always include goal so summaries resolve even when goal is not changing.
      goal: params.goal !== undefined ? params.goal : existing.goal,
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.progress !== undefined ? { progress: params.progress } : {}),
      ...(params.currentStage !== undefined
        ? { currentStage: params.currentStage }
        : {}),
      ...(params.expectedOutputs !== undefined
        ? { expectedOutputs: params.expectedOutputs }
        : {}),
      ...(params.addOutput !== undefined
        ? { addOutput: params.addOutput }
        : {}),
      ...(params.completeOutput !== undefined
        ? { completeOutput: params.completeOutput }
        : {}),
      // Carried so the PROPOSED path is not a silent no-op: the
      // `focus_session/update` executor re-applies it through the same append
      // door on approval.
      ...(params.addAgentId !== undefined
        ? { addAgentId: params.addAgentId }
        : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      // The discriminator MUST cross this boundary: this door is join-gate
      // reachable (the MCP handler threads `agentUserId`), and without it the
      // caller cannot tell a session-update proposal from a workspace-JOIN
      // gate filed instead of it. Its two siblings (create-session,
      // complete-session) already forward it.
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  // Build the field set. status is constrained to active|paused — closing a
  // session is synap_complete_session's job (it also closes the running
  // playbook_run); a raw status='closed' here would orphan that run.
  const set: Partial<typeof focusSessions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (params.goal !== undefined) set.goal = params.goal;
  if (params.status !== undefined) set.status = params.status;
  if (params.progress !== undefined) set.progress = params.progress;
  if (params.currentStage !== undefined) set.currentStage = params.currentStage;

  // Roster append goes through the ONE append door, which owns its own row lock
  // and its own idempotency. Deliberately NOT folded into `set` below: assigning
  // `agentIds` here would be a second wholesale writer of the column, which is
  // exactly the shape that left it unappendable in the first place.
  if (params.addAgentId !== undefined) {
    const { attachSessionAgent } = await import("./attach-session-agent.js");
    await attachSessionAgent({
      sessionId,
      agentId: params.addAgentId,
      userId,
    });
  }

  // addOutput / completeOutput / a full expectedOutputs replace mutate the
  // JSONB deliverables array. Do the read-modify-write inside a transaction
  // with a row lock (`FOR UPDATE`) so two concurrent edits can't both read
  // the same base array and lose one's item (TOCTOU).
  const mutatesOutputs =
    params.addOutput !== undefined ||
    typeof params.completeOutput === "string" ||
    params.expectedOutputs !== undefined;

  const [updated] = await db.transaction(async (tx) => {
    if (mutatesOutputs) {
      const [locked] = await tx
        .select({ expectedOutputs: focusSessions.expectedOutputs })
        .from(focusSessions)
        .where(eq(focusSessions.id, sessionId))
        .for("update");
      const current: OutputItem[] = Array.isArray(locked?.expectedOutputs)
        ? (locked.expectedOutputs as OutputItem[])
        : [];
      // Wholesale replace goes through the ONE merge, so a client that sends
      // back the four fields it knows about cannot erase a delegation, a return
      // note or an approval's lineage.
      let next: OutputItem[] = params.expectedOutputs
        ? mergeExpectedOutputs(current, params.expectedOutputs)
        : current;
      if (params.addOutput) {
        const add = params.addOutput;
        next = [
          ...next,
          {
            kind: add.kind,
            label: add.label,
            icon: add.icon,
            status: "pending",
          },
        ];
      }
      if (typeof params.completeOutput === "string") {
        const label = params.completeOutput;
        next = next.map((o) =>
          o.label === label ? { ...o, status: "done" as const } : o
        );
      }
      set.expectedOutputs = next;
    }
    return tx
      .update(focusSessions)
      .set(set)
      .where(eq(focusSessions.id, sessionId))
      .returning();
  });

  // Stage transition side-effect: when the active stage actually changes,
  // emit `focus_session.stage_changed` so automations can react (mirrors the
  // tRPC + Hub REST update doors). No-op for stageless / unchanged stages.
  if (
    params.currentStage !== undefined &&
    params.currentStage !== existing.currentStage
  ) {
    const { emitSideEffects } = await import("@synap/events");
    emitSideEffects({
      subjectType: "focus_session",
      action: "stage_changed",
      subjectId: updated.id,
      userId,
      workspaceId: existing.workspaceId,
      data: {
        sessionId: updated.id,
        subjectId: existing.subjectEntityId,
        playbookId: existing.playbookId,
        fromStage: existing.currentStage,
        toStage: updated.currentStage,
        workspaceId: existing.workspaceId,
        userId,
      },
    });
  }

  // ── HUMAN GATE ON STAGE ENTRY ───────────────────────────────────────────────
  // A stage may declare `gate: { kind: "human" }`. Advancing INTO it pauses the
  // session and files a proposal; the stage STANDS (the write above already
  // landed — see services/playbooks/stage-gate.ts for why the gate is a pause
  // and not a veto). Ungated stages, stageless playbooks and unchanged stages
  // cost nothing: the resolver is only consulted when the stage actually moved.
  //
  // DOOR PARITY: this is one of THREE stage-advance implementations
  // (`routers/focus-sessions.ts`, `jobs/steps/output.ts` and this service).
  // Only this one — the MCP/agent door — is wired today; the other two are
  // named as follow-ups rather than edited under a concurrent change.
  let gatedStatus: typeof updated.status | undefined;
  if (
    params.currentStage !== undefined &&
    params.currentStage !== existing.currentStage
  ) {
    const { applyStageGateOnAdvance } =
      await import("../playbooks/stage-gate.js");
    const gate = await applyStageGateOnAdvance({
      sessionId: updated.id,
      userId,
      agentUserId,
      workspaceId: existing.workspaceId,
      projectId: existing.projectId,
      channelId: existing.channelId,
      playbookId: existing.playbookId,
      toStage: params.currentStage,
      fromStage: existing.currentStage,
    });
    // Report the status the ROW now holds, not the one this call asked for —
    // a caller told "active" while the pod has it paused would step straight
    // past the gate it just opened.
    if (gate?.paused) gatedStatus = "paused";
  }

  return {
    status: "updated",
    session: gatedStatus ? { ...updated, status: gatedStatus } : updated,
  };
}
