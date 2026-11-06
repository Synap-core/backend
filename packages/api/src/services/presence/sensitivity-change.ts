/**
 * The one door that changes what asks for a passkey on this pod (W5, founder
 * 6 Nov 2026: "pod settings (pod admin) should enable the user to select what
 * is considered sensitive & what is not"). Kept apart from `mode.ts`, which
 * every gated call reads, so the read path imports no notification graph.
 *
 * Switching a row OFF lets a signed-in session alone do more, so it needs a
 * proof of presence for `presence_sensitivity:<id of the new choice>` in
 * EVERY mode, as switching the whole check off does. Switching rows back ON
 * only takes power away: it is free. Every change is recorded
 * (`presence.sensitivity_changed`, the audit log) and announced to every pod
 * admin.
 */
import {
  normalizePresenceSensitivity,
  PRESENCE_REQUIRED,
  presenceRequestSubject,
  presenceSensitivityId,
  sensitivityLoosens,
  type PresenceProof,
  type PresenceSensitivityChoice,
} from "@synap-core/types/presence";
import { EventRepository, sql } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { auditLog } from "../../utils/audit-log.js";
import { assertPresenceForRequest, presenceRequiredMessage } from "./gate.js";
import { notifyPodAdmins } from "./mode-change.js";
import {
  readPresenceSensitivity,
  writePresenceSensitivity,
  type PresenceSensitivityState,
} from "./mode.js";

/**
 * Change what asks for a passkey (`presence.setSensitivity`; the caller has
 * checked the pod admin and the signed-in person). Rows unknown to the lists
 * are dropped. A choice equal to the current one writes nothing.
 */
export async function changePresenceSensitivity(args: {
  userId: string;
  choice: PresenceSensitivityChoice;
  proof?: PresenceProof | null;
}): Promise<PresenceSensitivityState> {
  const current = await readPresenceSensitivity();
  const next = normalizePresenceSensitivity(args.choice);
  const loosens = sensitivityLoosens(current, next);
  const switchedOff = {
    approvals: next.approvalsOff.filter(
      (k) => !current.approvalsOff.includes(k)
    ),
    actions: next.actionsOff.filter((k) => !current.actionsOff.includes(k)),
  };
  const switchedOn = {
    approvals: current.approvalsOff.filter(
      (k) => !next.approvalsOff.includes(k)
    ),
    actions: current.actionsOff.filter((k) => !next.actionsOff.includes(k)),
  };
  const changed =
    switchedOff.approvals.length +
      switchedOff.actions.length +
      switchedOn.approvals.length +
      switchedOn.actions.length >
    0;
  if (!changed) return current;

  if (loosens) {
    const id = await presenceSensitivityId(next);
    // Always a proof, whatever the mode in force: letting a session alone do
    // more must never be a move a session alone can make.
    if (!args.proof) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: await presenceRequiredMessage(
          args.userId,
          "Confirm it is you: no longer asking for your passkey needs Face ID, Touch ID or your passkey."
        ),
        cause: {
          reasonCode: PRESENCE_REQUIRED,
          proposalId: presenceRequestSubject("presence_sensitivity", id),
        },
      });
    }
    await assertPresenceForRequest({
      userId: args.userId,
      kind: "presence_sensitivity",
      id,
      proof: args.proof,
      door: "presence.setSensitivity",
    });
  }

  const saved = await writePresenceSensitivity({
    choice: next,
    changedBy: args.userId,
  });
  const data = { switchedOff, switchedOn, proved: loosens };
  await new EventRepository(sql).append({
    id: randomUUID(),
    version: "v1",
    type: "presence.sensitivity_changed",
    subjectType: "presence_sensitivity",
    userId: args.userId,
    source: "api",
    timestamp: new Date(),
    data,
  });
  await notifyPodAdmins({
    type: "security.presence_sensitivity_changed",
    byUserId: args.userId,
    data: {
      off: switchedOff.approvals.length + switchedOff.actions.length,
      on: switchedOn.approvals.length + switchedOn.actions.length,
    },
  });
  void auditLog({
    subjectType: "presence_sensitivity",
    action: "update",
    phase: "completed",
    subjectId: "presence_sensitivity",
    userId: args.userId,
    workspaceId: null,
    data,
  });
  return saved;
}
