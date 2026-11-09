/**
 * The two asks of self-healing installations (`self-heal.ts`), each sent ONCE
 * at the event that makes it true, never from the reconciler's per-lease pass:
 *
 *   - `installation.self_heal_stopped`: the finish of the job that brought the
 *     installation's consecutive failures to {@link SELF_HEAL_MAX_FAILURES}.
 *     The pod has stopped trying; the person sees what failed and what to do.
 *     A later failure (a person's own retry) is past the cap and tells nobody:
 *     they ran it at the keyboard and saw why.
 *   - `installation.prerequisite_needed`: the approval of an install whose
 *     prerequisite (`placement.requires.capabilities`) has no live
 *     installation on that computer. The install waits; approving the
 *     prerequisite there lets it go after it.
 *
 * ONE door, `NotificationService.create`, to the installation's owner, with
 * `groupKey` `installation:<id>` and the registry's dedupe window.
 */

import { createLogger } from "@synap-core/core";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { db, eq } from "@synap/database";
import {
  capabilities,
  installations,
  users,
  type InstallationRow,
} from "@synap/database/schema";
import { NotificationService } from "../../notifications/NotificationService.js";
import { machineName } from "../machine-roster.js";
import {
  consecutiveFailures,
  loadInstallationJobHistory,
  SELF_HEAL_MAX_FAILURES,
} from "./self-heal.js";

const logger = createLogger({ module: "installation-self-heal-notice" });

/** Spelled as `type:` so the producer tripwire sees this file produce them. */
const stopped = { type: "installation.self_heal_stopped" } as const;
const prerequisite = { type: "installation.prerequisite_needed" } as const;
export const INSTALLATION_SELF_HEAL_STOPPED_NOTIFICATION_TYPE = stopped.type;
export const INSTALLATION_PREREQUISITE_NEEDED_NOTIFICATION_TYPE =
  prerequisite.type;

export interface SelfHealNoticeDeps {
  create(
    input: Parameters<typeof NotificationService.create>[0]
  ): Promise<string | undefined>;
}

const defaultDeps: SelfHealNoticeDeps = {
  create: (input) => NotificationService.create(input),
};

/** The words a card names an installation by: its capability and its computer. */
async function namesOf(
  row: Pick<InstallationRow, "capabilityId" | "capabilityKey" | "machineUserId">
): Promise<{ name: string; computer: string }> {
  const [cap] = row.capabilityId
    ? await db
        .select({ name: capabilities.name })
        .from(capabilities)
        .where(eq(capabilities.id, row.capabilityId))
        .limit(1)
    : [];
  const [computer] = await db
    .select({ name: users.name, agentMetadata: users.agentMetadata })
    .from(users)
    .where(eq(users.id, row.machineUserId))
    .limit(1);
  return {
    name: cap?.name?.trim() || humanizeToken(row.capabilityKey),
    computer: computer ? machineName(computer) : humanizeToken("machine"),
  };
}

/**
 * Called by the finish of a failed lifecycle job. Sends the card when this
 * failure is the one that reached the cap. Returns whether it sent one.
 * Never throws: a card that could not be sent never fails the finish.
 */
export async function notifyIfSelfHealStopped(
  installationId: string,
  deps: SelfHealNoticeDeps = defaultDeps
): Promise<boolean> {
  try {
    const history = await loadInstallationJobHistory(installationId);
    const failures = consecutiveFailures(history);
    if (failures !== SELF_HEAL_MAX_FAILURES) return false;
    const [row] = await db
      .select()
      .from(installations)
      .where(eq(installations.id, installationId))
      .limit(1);
    if (!row) return false;
    const { name, computer } = await namesOf(row);
    const removing = row.desiredState === "removed";
    const id = await deps.create({
      type: INSTALLATION_SELF_HEAL_STOPPED_NOTIFICATION_TYPE,
      userId: row.userId,
      workspaceId: row.workspaceId ?? null,
      sourceType: "system",
      sourceId: `installation:${row.id}:${history[0]?.queuedAt.toISOString() ?? ""}`,
      groupKey: `installation:${row.id}`,
      data: {
        installationId: row.id,
        capabilityKey: row.capabilityKey,
        name,
        computer,
        action: removing ? "remove" : "install",
        attempts: failures,
        lastError: row.statusDetail?.trim() || "no reason was recorded",
      },
    });
    return !!id;
  } catch (err) {
    logger.warn(
      { err, installationId },
      "Self-heal stopped card failed (non-fatal)"
    );
    return false;
  }
}

/**
 * Called when an install is approved and waits for prerequisites nobody
 * approved on that computer. Never throws.
 */
export async function notifyPrerequisiteNeeded(
  row: InstallationRow,
  missing: readonly string[],
  deps: SelfHealNoticeDeps = defaultDeps
): Promise<boolean> {
  if (missing.length === 0) return false;
  try {
    const { name, computer } = await namesOf(row);
    const [first] = await db
      .select({ name: capabilities.name })
      .from(capabilities)
      .where(eq(capabilities.templateKey, missing[0]!))
      .limit(1);
    const id = await deps.create({
      type: INSTALLATION_PREREQUISITE_NEEDED_NOTIFICATION_TYPE,
      userId: row.userId,
      workspaceId: row.workspaceId ?? null,
      sourceType: "system",
      sourceId: `installation:${row.id}:prerequisite`,
      groupKey: `installation:${row.id}:prerequisite`,
      data: {
        installationId: row.id,
        capabilityKey: row.capabilityKey,
        name,
        computer,
        prerequisite: first?.name?.trim() || humanizeToken(missing[0]!),
        prerequisiteKey: missing[0],
        others: missing.length - 1,
      },
    });
    return !!id;
  } catch (err) {
    logger.warn(
      { err, installationId: row.id },
      "Prerequisite card failed (non-fatal)"
    );
    return false;
  }
}
