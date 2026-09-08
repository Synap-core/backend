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
import { BLOCKED_REASONS, type ExpectedOutput } from "@synap/playbooks";
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
  /**
   * Append ONE slot. `owner`/`blockedReason`/`why` make this the door an agent
   * uses to declare a slot it CANNOT take: the work is named on the board, the
   * blocker is classified, and the human reads one line to know what to do.
   * The slot lands `pending` like any other — declaring a blocker is not a
   * claim of delivery, and `status: 'done'` is still the approval door's.
   */
  addOutput?: {
    kind: string;
    label: string;
    icon?: string;
    owner?: ExpectedOutput["owner"];
    blockedReason?: ExpectedOutput["blockedReason"];
    why?: ExpectedOutput["why"];
  };
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
  | {
      status: "updated";
      session: typeof focusSessions.$inferSelect;
      /**
       * What the patch's `completeOutput` did — present only when the patch
       * carried one. It MUST cross this boundary: the governance floor that
       * refuses to close a human-owned slot changes nothing on the row, so a
       * caller handed only the session object reads a refusal as a success and
       * moves on believing the work is delivered.
       */
      completeOutput?: CompleteOutputOutcome;
    };

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
  // Blocked-on-human slot. `owner` absent ⇒ `agent` (see ExpectedOutput).
  //
  // NOT cross-field-refined ("blockedReason/why only with owner:'human'"). That
  // rule is CONVENTIONAL here on purpose: this schema parses WHOLESALE patches,
  // and {@link mergeExpectedOutputs} carries forward the server-owned fields an
  // incoming item is silent about — so a legal patch may legitimately arrive
  // carrying `owner` without `blockedReason` (the stored one is about to be
  // re-attached) or vice versa. A refinement at the parse sees only the incoming
  // half and would reject writes the merge is designed to accept.
  owner: z.enum(["human", "agent"]).optional(),
  blockedReason: z.enum(BLOCKED_REASONS).optional(),
  why: z.string().max(500).optional(),
  // Server-stamped alongside `owner: 'human'` (see `reconcileOwedSince`). It is
  // ON the wire only so a caller round-tripping a stored slot does not lose it
  // at the parse — never so a client can author a time it did not observe; the
  // reconciler overwrites whatever arrives that contradicts `owner`.
  owedSince: z.string().optional(),
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
 *
 * MEMBERSHIP IS ABOUT ERASURE, NOT AUTHORITY. Being listed here does not make a
 * field unwritable by an agent — `owner`/`blockedReason`/`why` are the agent's
 * own declaration, written through `addOutput`. It makes the field survive the
 * NEXT wholesale patch by a client that has never heard of it. Every key of
 * `ExpectedOutput` except the three a client authors (`kind`, `label`, `icon`)
 * belongs here, and `__tripwires__/expected-output-server-owned-coverage.test.ts`
 * derives that set from the type so a new field cannot be silently omitted —
 * `satisfies ReadonlyArray<keyof ExpectedOutput>` permits omission, which is
 * exactly the erasure bug described above.
 */
export const CLIENT_AUTHORED_OUTPUT_FIELDS = [
  "kind",
  "label",
  "icon",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

export const SERVER_OWNED_OUTPUT_FIELDS = [
  "status",
  "claimedDone",
  "satisfiedByProposalId",
  "delegatedTo",
  "delegatedAt",
  "returnedReason",
  "returnedAt",
  "owner",
  "blockedReason",
  "why",
  "owedSince",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

/**
 * COMPILE-TIME coverage floor for the list above.
 *
 * `satisfies ReadonlyArray<keyof ExpectedOutput>` only checks that each listed
 * name IS a field — it happily accepts a list that OMITS one, and an omitted
 * field is silently erased by the next wholesale patch. This says the other
 * direction: every key of `ExpectedOutput` that is not client-authored must be
 * in the list, or `Exclude<...>` fails to extend the tuple union, the alias
 * resolves to `never`, and this assignment stops the build. A new field on the
 * interface is therefore a TYPECHECK error until it is classified — no test run
 * required, and nothing for a regex to be blinded by.
 */
type _ServerOwnedCoversEveryField =
  Exclude<
    keyof ExpectedOutput,
    (typeof CLIENT_AUTHORED_OUTPUT_FIELDS)[number]
  > extends (typeof SERVER_OWNED_OUTPUT_FIELDS)[number]
    ? true
    : never;
const _serverOwnedCoverage: _ServerOwnedCoversEveryField = true;
void _serverOwnedCoverage;

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
    return reconcileOwedSince({ ...item, ...carried });
  });
}

/**
 * THE `owedSince` INVARIANT, in one place: the stamp is present IFF the slot is
 * owned by the human.
 *
 * `owner: 'human'` is authored by an agent (through `addOutput`, a wholesale
 * patch, or `blockExpectedOutput`), but the TIME it became owed is an
 * observation only the server can make — the same split `delegatedAt` has from
 * `delegatedTo`. So every path that can change `owner` runs the slot through
 * here rather than each stamping its own timestamp, and a client that sends a
 * fabricated `owedSince` on a slot it is handing BACK to the agent has it
 * dropped rather than believed.
 *
 * An ALREADY-owed slot keeps its original stamp: re-declaring the same blocker
 * must not reset the clock the "needs you" feed ages rows by.
 */
export function reconcileOwedSince(
  item: OutputItem,
  now: Date = new Date()
): OutputItem {
  if (item.owner === "human") {
    return item.owedSince ? item : { ...item, owedSince: now.toISOString() };
  }
  if (item.owedSince === undefined) return item;
  const { owedSince: _dropped, ...rest } = item;
  return rest;
}

/**
 * What a `completeOutput` in the patch ACTUALLY did — the report that makes the
 * governance floor below observable to whoever asked.
 *
 * Three outcomes, and they must stay tellable apart. `completed` is the write.
 * `refused` is the floor: the slot is the human's and the agent may not close
 * it — actionable, the caller should stop claiming the work is done. `no_match`
 * is the DOCUMENTED contract of this field (the MCP tool advertises "no-op if no
 * deliverable matches the label exactly"), not an error — but a caller still has
 * to be able to distinguish "you spelled the label wrong" from "you are not
 * allowed", which is exactly what a bare 200 with an unchanged row cannot do.
 */
export type CompleteOutputOutcome = {
  /** The label the caller asked to complete, verbatim. */
  label: string;
  /** Matching slots that were stamped done. */
  completed: number;
  /** Matching slots REFUSED because `owner: 'human'`. */
  refusedHumanOwned: number;
  /** The one-word verdict, derived from the two counts above. */
  result: "completed" | "refused" | "no_match";
  /**
   * Caller-facing sentence for the two non-success verdicts. Absent when the
   * mark landed — a success needs no explanation, and an always-present message
   * is the thing callers learn to ignore.
   */
  message?: string;
};

/** The outputs array a patch produced, plus the report of what it refused. */
export interface OutputMutationResult {
  outputs: OutputItem[];
  /** Present only when the patch carried a `completeOutput`. */
  completeOutput?: CompleteOutputOutcome;
}

/**
 * Turn the two match counts into the verdict + its sentence. Lives OUTSIDE
 * {@link applyOutputMutations} deliberately: prose wedged between that
 * function's `patch.completeOutput` read and its `status: "done"` literal blinds
 * the `__tripwires__/expected-output-done-one-door.test.ts` proximity window to
 * the residual it exists to pin.
 */
function describeCompleteOutput(
  label: string,
  completed: number,
  refusedHumanOwned: number
): CompleteOutputOutcome {
  if (completed > 0) {
    return { label, completed, refusedHumanOwned, result: "completed" };
  }
  if (refusedHumanOwned > 0) {
    return {
      label,
      completed,
      refusedHumanOwned,
      result: "refused",
      message: `"${label}" is the human's slot — you declared it owner: "human", so you cannot mark it done. Nothing was changed. Reclaim the slot first (clear its blocker) if you did the work after all, or leave it for the human.`,
    };
  }
  return {
    label,
    completed,
    refusedHumanOwned,
    result: "no_match",
    message: `No deliverable is labelled exactly "${label}". Nothing was changed. Labels match verbatim — list the session's deliverables and resend the exact label.`,
  };
}

/**
 * The three output mutations a `focus_session/update` can carry, applied to the
 * CURRENT stored array. Pure, and EXPORTED because it has two callers that must
 * not drift: this service's row-locked write, and the `focus_session/update`
 * proposal executor, which re-applies the very same patch on approval. When the
 * executor had its own inline field list it applied none of these at all, and
 * approving a slot change returned success while changing nothing.
 *
 * Returns the new array ALONGSIDE the `completeOutput` report rather than
 * throwing on a refusal: a wholesale patch that merely happens to mention a
 * blocked label must still land its other mutations, and both callers already
 * run inside a row lock a throw would abort.
 */
export function applyOutputMutations(
  current: OutputItem[],
  patch: {
    expectedOutputs?: OutputItem[];
    addOutput?: UpdateFocusSessionParams["addOutput"];
    completeOutput?: string;
  }
): OutputMutationResult {
  // Wholesale replace goes through the ONE merge, so a client that sends back
  // the four fields it knows about cannot erase a delegation, a return note or
  // an approval's lineage.
  let next: OutputItem[] = patch.expectedOutputs
    ? mergeExpectedOutputs(current, patch.expectedOutputs)
    : current;

  if (patch.addOutput) {
    const add = patch.addOutput;
    next = [
      ...next,
      reconcileOwedSince({
        kind: add.kind,
        label: add.label,
        icon: add.icon,
        status: "pending",
        // Only spread what was actually declared — an absent `owner` MUST
        // stay absent (it is what "the agent never said" looks like), not
        // become an explicit "agent".
        ...(add.owner !== undefined ? { owner: add.owner } : {}),
        ...(add.blockedReason !== undefined
          ? { blockedReason: add.blockedReason }
          : {}),
        ...(add.why !== undefined ? { why: add.why } : {}),
      }),
    ];
  }
  // GOVERNANCE FLOOR on the branch below — an agent may not complete a slot it
  // handed to the human. `owner: 'human'` is the agent's own declaration that it
  // CANNOT do this work; letting the same caller then mark it done would make
  // the declaration a way to close work nobody did. (The wider residual — that
  // this stamps `status` at all instead of `claimedDone` — is pinned in
  // `__tripwires__/expected-output-done-one-door.test.ts` and deliberately
  // untouched here. Keep this prose OUTSIDE the branch: that tripwire matches
  // `completeOutput` within 400 chars of the `done` literal, and a comment
  // wedged between the two blinds it to the very residual it pins.)

  let completeOutput: CompleteOutputOutcome | undefined;
  if (typeof patch.completeOutput === "string") {
    const label = patch.completeOutput;
    let completed = 0;
    let refused = 0;
    next = next.map((o) => {
      if (o.label !== label) return o;
      if (o.owner === "human") {
        refused += 1;
        return o;
      }
      completed += 1;
      return { ...o, status: "done" as const };
    });
    completeOutput = describeCompleteOutput(label, completed, refused);
  }

  return { outputs: next, ...(completeOutput ? { completeOutput } : {}) };
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

  // Captured out of the transaction so the RETURN can report it — see the
  // `completeOutput` field on UpdateFocusSessionResult.
  let completeOutputOutcome: CompleteOutputOutcome | undefined;

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
      const applied = applyOutputMutations(current, {
        expectedOutputs: params.expectedOutputs,
        addOutput: params.addOutput,
        completeOutput: params.completeOutput,
      });
      set.expectedOutputs = applied.outputs;
      completeOutputOutcome = applied.completeOutput;
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
    ...(completeOutputOutcome ? { completeOutput: completeOutputOutcome } : {}),
  };
}
