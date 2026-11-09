/**
 * The two asks of self-healing installations (`self-heal.ts`), each ONE tap
 * on the person's phone: an `installation/request` proposal the pod files on
 * its own (`requestInstallation` with `filedByPod`), the card Relay already
 * decides in one tap, never a keyboard step. Each is filed ONCE, at the event
 * that makes it true, never from the reconciler's per-lease pass:
 *
 *   - "try again": the finish of the job that brought the installation's
 *     consecutive failures to {@link SELF_HEAL_MAX_FAILURES}. The pod has
 *     stopped trying; the card says what failed, in plain words, and
 *     approving it runs the repair (or the removal) now, past the ladder
 *     (`applyInstallationRequest`: an approved repair is the person's own
 *     ask). A later failure is past the cap and asks nothing again.
 *   - "approve the prerequisite": the approval of an install whose
 *     prerequisite (`placement.requires.capabilities`) has no live
 *     installation on that computer. The card IS the prerequisite's install
 *     on that computer (from the marketplace when the pod does not have it);
 *     approving it lets the waiting install go right after.
 *
 * The proposer is the computer (its machine agent), the author the pod
 * (`system:installation-self-heal`); the person decides.
 */

import { createLogger } from "@synap-core/core";
import { db, eq } from "@synap/database";
import { installations, type InstallationRow } from "@synap/database/schema";
import {
  consecutiveFailures,
  loadInstallationJobHistory,
  SELF_HEAL_MAX_FAILURES,
} from "./self-heal.js";
import type {
  InstallationAsk,
  InstallationAskInput,
} from "./request-installation.js";

const logger = createLogger({ module: "installation-self-heal-ask" });

export const SELF_HEAL_AUTHOR = "system:installation-self-heal" as const;

export interface SelfHealAskDeps {
  request(input: InstallationAskInput): Promise<InstallationAsk>;
}

const defaultDeps: SelfHealAskDeps = {
  request: async (input) =>
    (await import("./request-installation.js")).requestInstallation(input),
};

/** The person's computer this installation is on, as the ask door names it. */
async function computerOf(row: InstallationRow) {
  const { loadPersonsComputer } = await import("./installations.js");
  return loadPersonsComputer(row.userId, row.machineUserId);
}

/** A failure sentence a person reads: the stored one, never a raw blank. */
function plainError(row: InstallationRow): string {
  const text = row.statusDetail?.trim();
  if (text) return /[.!?]$/.test(text) ? text : `${text}.`;
  if (row.health?.verify && !row.health.verify.ok)
    return row.health.verify.exitCode === null
      ? "Its check could not run: the program did not start, or it took too long."
      : `Its check failed (exit code ${row.health.verify.exitCode}).`;
  return "No reason was recorded.";
}

/** The sentence on the "try again" card. Pure. */
export function tryAgainReasoning(
  row: Pick<InstallationRow, "capabilityKey" | "desiredState">,
  computer: string,
  attempts: number,
  lastError: string
): string {
  const removing = row.desiredState === "removed";
  const what = removing
    ? `The pod tried ${attempts} times to remove ${row.capabilityKey} from ${computer} and stopped.`
    : `The pod tried ${attempts} times to make ${row.capabilityKey} work on ${computer}, as you approved it, and stopped.`;
  const tap = removing
    ? "Approve to try removing it again now."
    : "Approve to try again now.";
  const hint = removing
    ? `To see each step, run \`synap tools remove ${row.capabilityKey}\` on ${computer}.`
    : `To see each step, run \`synap tools install ${row.capabilityKey}\` on ${computer}.`;
  return `${what} Last error: ${lastError} ${tap} ${hint}`;
}

/**
 * Called by the finish of a failed lifecycle job. Files the "try again" card
 * when this failure is the one that reached the cap. Returns whether it filed
 * one. Never throws: an ask that could not be filed never fails the finish.
 */
export async function askToTryAgainIfStopped(
  installationId: string,
  deps: SelfHealAskDeps = defaultDeps
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
    const computer = await computerOf(row);
    if (!computer) return false;
    const ask = await deps.request({
      userId: row.userId,
      agentUserId: row.machineUserId,
      computer,
      capabilityKey: row.capabilityKey,
      action: row.desiredState === "removed" ? "remove" : "install",
      filedByPod: {
        author: SELF_HEAL_AUTHOR,
        reasoning: tryAgainReasoning(
          row,
          computer.name,
          failures,
          plainError(row)
        ),
      },
    });
    if (ask.status !== "proposed")
      logger.warn(
        { installationId, status: ask.status },
        "Self-heal try-again ask was not filed as a proposal"
      );
    return ask.status === "proposed";
  } catch (err) {
    logger.warn(
      { err, installationId },
      "Self-heal try-again ask failed (non-fatal)"
    );
    return false;
  }
}

/**
 * Called when an install is approved and waits for prerequisites nobody
 * approved on that computer: ONE card per prerequisite, which is that
 * prerequisite's install on the computer. Never throws.
 */
export async function askForPrerequisites(
  row: InstallationRow,
  missing: readonly string[],
  deps: SelfHealAskDeps = defaultDeps
): Promise<number> {
  let filed = 0;
  try {
    const computer = await computerOf(row);
    if (!computer) return 0;
    for (const key of missing) {
      const ask = await deps.request({
        userId: row.userId,
        agentUserId: row.machineUserId,
        computer,
        capabilityKey: key,
        action: "install",
        fromCatalog: true,
        filedByPod: {
          author: SELF_HEAL_AUTHOR,
          reasoning: `${row.capabilityKey} on ${computer.name} needs ${key} first. Approve to install ${key} there; ${row.capabilityKey} installs right after it.`,
        },
      });
      if (ask.status === "proposed") filed += 1;
      else
        logger.warn(
          { installationId: row.id, prerequisite: key, status: ask.status },
          "Prerequisite ask was not filed as a proposal"
        );
    }
  } catch (err) {
    logger.warn(
      { err, installationId: row.id },
      "Prerequisite ask failed (non-fatal)"
    );
  }
  return filed;
}
