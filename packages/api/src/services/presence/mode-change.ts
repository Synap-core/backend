/**
 * The one door that changes the proof-of-presence mode, and its notice to the
 * pod admins (W3 slice 3). Kept apart from `mode.ts`, which every gated call
 * reads, so the read path imports no notification graph.
 */
import { createLogger } from "@synap-core/core";
import { POD_ADMIN_SYSTEM_SLUG } from "@synap-core/types/console";
import {
  PRESENCE_REQUIRED,
  presenceRequestSubject,
  type PresenceProof,
} from "@synap-core/types/presence";
import { and, db, eq, inArray, isNull } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { NotificationService } from "../../notifications/NotificationService.js";
import { auditLog } from "../../utils/audit-log.js";
import { assertPresenceForRequest, presenceRequiredMessage } from "./gate.js";
import {
  readPresenceMode,
  recordModeChange,
  writePresenceMode,
  type PresenceMode,
  type PresenceModeState,
} from "./mode.js";

const logger = createLogger({ module: "presence-mode" });

/**
 * Tell every pod admin the proof of presence was switched OFF (back to
 * `report`), and by whom. A notice that cannot be written is logged as an
 * error; the change and its event stand.
 */
export async function notifyAdminsPresenceOff(byUserId: string): Promise<void> {
  try {
    const podAdminWorkspace = await db.query.workspaces.findFirst({
      where: and(
        eq(workspaces.systemSlug, POD_ADMIN_SYSTEM_SLUG),
        isNull(workspaces.archivedAt)
      ),
      columns: { id: true },
    });
    if (!podAdminWorkspace) return;
    const admins = await db.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
        inArray(workspaceMembers.role, ["admin", "owner"])
      ),
      columns: { userId: true },
    });
    for (const admin of admins) {
      await NotificationService.create({
        type: "security.presence_mode_changed",
        workspaceId: podAdminWorkspace.id,
        userId: admin.userId,
        sourceType: "system",
        sourceId: byUserId,
        data: { mode: "report", byUserId },
      });
    }
  } catch (err) {
    logger.error(
      { err, byUserId },
      "proof of presence switched off, but the pod admins could not be notified"
    );
  }
}

/**
 * The one door that changes the mode (`presence.setMode`; the caller has
 * checked the pod admin and the signed-in person). ON (`enforce`) is free: it
 * only takes power away. OFF (`report`) needs a proof of presence for
 * `presence_mode:report` in EVERY mode, is recorded (`presence.mode_changed`)
 * and announced to every pod admin. An operator env floor cannot be switched
 * off here.
 */
export async function changePresenceMode(args: {
  userId: string;
  mode: PresenceMode;
  proof?: PresenceProof | null;
}): Promise<PresenceModeState> {
  const current = await readPresenceMode();
  if (args.mode === "report") {
    if (current.source === "env") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "This pod's operator turned it on in the pod's environment (SYNAP_PRESENCE_PROOF). It can't be turned off here.",
      });
    }
    // Always a proof, whatever the mode in force: switching the check off
    // must never be the one move a session alone can make.
    if (!args.proof) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: await presenceRequiredMessage(
          args.userId,
          "Confirm it is you: turning this off needs Face ID, Touch ID or your passkey."
        ),
        cause: {
          reasonCode: PRESENCE_REQUIRED,
          proposalId: presenceRequestSubject("presence_mode", "report"),
        },
      });
    }
    await assertPresenceForRequest({
      userId: args.userId,
      kind: "presence_mode",
      id: "report",
      proof: args.proof,
      door: "presence.setMode",
    });
  }
  const next = await writePresenceMode({
    mode: args.mode,
    changedBy: args.userId,
  });
  if (current.mode !== next.mode) {
    await recordModeChange({
      userId: args.userId,
      from: current.mode,
      to: next.mode,
      proved: args.mode === "report",
    });
    if (next.mode === "report") await notifyAdminsPresenceOff(args.userId);
  }
  void auditLog({
    subjectType: "presence_mode",
    action: "update",
    phase: "completed",
    subjectId: "presence_mode",
    userId: args.userId,
    workspaceId: null,
    data: { from: current.mode, to: next.mode },
  });
  return next;
}
