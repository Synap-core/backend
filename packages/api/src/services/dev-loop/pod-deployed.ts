/**
 * `dev.deployed` — the pod tells itself a new build is live (plan v5 T2:
 * "deploy → the pod knows"). Before it, only a FAILED update reached the pod
 * (`notifications/pod-update-outcome.ts`, a bell row); a successful one left
 * no fact an automation could trigger on, so "deployed to lab → start a
 * dogfood run" could not be stored config.
 *
 * Read at BOOT, from the same outcome record the failure notice reads
 * (`deploy/state/last-update.json`, apps/api `pod-updates`): the update
 * recreates the backend, so the boot that follows is when the new build is
 * live. Recorded through the ONE observation writer (`recordObservation`) as
 * the pod OWNER (no agent: the pod reports its own state), so it fires event
 * automations exactly like a producer's fact.
 *
 * The sha is the RUNNING build (`SYNAP_GIT_SHA`, stamped at image build), not
 * the version string the engine wrote: what is live is what the process runs.
 *
 * IDEMPOTENT per update id: the subject is `pod-update:<updateId>`, and a boot
 * that finds a `dev.deployed` event on that subject records nothing. Never
 * throws: a pod boots whether or not its own fact could be recorded.
 */

import { createLogger } from "@synap-core/core";
import { DEV_LOOP_EVENT_TYPES, checkDevLoopPayload } from "@synap-core/types";
import { and, db, eq, events } from "@synap/database";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import {
  deriveSubjectUuid,
  recordObservation,
  type RecordObservationInput,
} from "../observations/record-observation.js";

const logger = createLogger({ module: "dev-loop/pod-deployed" });

/** The engine's success verdict (`synap` `_ue_record`; `noop` changed nothing). */
export const POD_UPDATE_SUCCEEDED = "succeeded";

export interface PodDeployedOutcome {
  updateId: string;
  status: string;
  from: string | null;
  to: string | null;
  at: string | null;
}

export type PodDeployedResult =
  | { status: "recorded"; id: string }
  | {
      status: "skipped";
      reason:
        | "not_a_success"
        | "no_build_sha"
        | "no_owner"
        | "already_recorded"
        | "invalid";
    }
  | { status: "failed"; error: string };

export interface PodDeployedDeps {
  /** The running build's sha (`SYNAP_GIT_SHA`). */
  buildSha(): string | null;
  /** Where the build is live — this pod's public host. */
  target(): string;
  owner(): Promise<string | null>;
  alreadyRecorded(subjectRef: string): Promise<boolean>;
  record(input: RecordObservationInput): Promise<{ id: string }>;
}

/** The subject one update's fact is recorded on. */
export function podDeployedSubjectRef(updateId: string): string {
  return `pod-update:${updateId}`;
}

const defaultDeps: PodDeployedDeps = {
  buildSha: () => process.env.SYNAP_GIT_SHA?.trim() || null,
  target: () => {
    const url = process.env.PUBLIC_URL?.trim();
    if (!url) return "pod";
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  },
  owner: resolvePodOwnerUserId,
  alreadyRecorded: async (subjectRef) => {
    const [row] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.type, DEV_LOOP_EVENT_TYPES.deployed),
          eq(events.subjectId, deriveSubjectUuid(subjectRef))
        )
      )
      .limit(1);
    return Boolean(row);
  },
  record: recordObservation,
};

export async function recordPodDeployed(
  outcome: PodDeployedOutcome,
  deps: PodDeployedDeps = defaultDeps
): Promise<PodDeployedResult> {
  if (outcome.status !== POD_UPDATE_SUCCEEDED) {
    return { status: "skipped", reason: "not_a_success" };
  }
  const sha = deps.buildSha();
  const data = {
    target: deps.target(),
    sha: sha ?? "",
    updateId: outcome.updateId,
    from: outcome.from,
    to: outcome.to,
  };
  // The fact obeys the same contract a producer's does.
  const contract = checkDevLoopPayload(DEV_LOOP_EVENT_TYPES.deployed, data);
  if (!sha) return { status: "skipped", reason: "no_build_sha" };
  if (contract.contract && !contract.ok) {
    logger.warn({ error: contract.error }, "dev.deployed: payload refused");
    return { status: "skipped", reason: "invalid" };
  }
  try {
    const owner = await deps.owner();
    if (!owner) return { status: "skipped", reason: "no_owner" };
    const subjectRef = podDeployedSubjectRef(outcome.updateId);
    if (await deps.alreadyRecorded(subjectRef)) {
      return { status: "skipped", reason: "already_recorded" };
    }
    const at = outcome.at ? new Date(outcome.at) : null;
    const row = await deps.record({
      type: DEV_LOOP_EVENT_TYPES.deployed,
      subjectRef,
      subjectType: "deploy",
      data,
      userId: owner,
      ...(at && !Number.isNaN(at.getTime()) ? { occurredAt: at } : {}),
    });
    return { status: "recorded", id: row.id };
  } catch (err) {
    logger.warn({ err, updateId: outcome.updateId }, "dev.deployed failed");
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
