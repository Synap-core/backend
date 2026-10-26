/**
 * `dev.deployed` on a SUCCESSFUL pod update (plan v5 T2) — before it, only a
 * failure reached the pod (a bell row), so nothing could follow a deploy.
 * Deps are injected: what is under test is WHEN the fact is recorded, with
 * WHAT payload, as WHOM, and that a re-read boot records it once.
 */

import { describe, it, expect } from "vitest";
import { checkDevLoopPayload } from "@synap-core/types";
import {
  podDeployedSubjectRef,
  recordPodDeployed,
  type PodDeployedDeps,
} from "../pod-deployed.js";
import type { RecordObservationInput } from "../../observations/record-observation.js";

function fakeDeps(over: Partial<PodDeployedDeps> = {}) {
  const recorded: RecordObservationInput[] = [];
  const deps: PodDeployedDeps = {
    buildSha: () => "91de41c34abc",
    target: () => "pod.antoinesrvt.synap.live",
    owner: async () => "owner-1",
    alreadyRecorded: async () => false,
    record: async (input) => {
      recorded.push(input);
      return { id: "ev-1" };
    },
    ...over,
  };
  return { deps, recorded };
}

const success = {
  updateId: "u-42",
  status: "succeeded",
  from: "v1.4.0",
  to: "main-91de41c",
  at: "2026-10-27T03:00:00Z",
};

describe("recordPodDeployed", () => {
  it("records dev.deployed for a successful update — the running sha, this host, as the owner", async () => {
    const { deps, recorded } = fakeDeps();
    expect(await recordPodDeployed(success, deps)).toEqual({
      status: "recorded",
      id: "ev-1",
    });
    expect(recorded).toHaveLength(1);
    const r = recorded[0]!;
    expect(r).toMatchObject({
      type: "dev.deployed",
      subjectRef: "pod-update:u-42",
      userId: "owner-1",
      data: {
        target: "pod.antoinesrvt.synap.live",
        sha: "91de41c34abc",
        updateId: "u-42",
        from: "v1.4.0",
        to: "main-91de41c",
      },
    });
    // The pod reports its own state: no agent is the actor.
    expect(r.agentUserId).toBeUndefined();
    expect(r.occurredAt?.toISOString()).toBe("2026-10-27T03:00:00.000Z");
    // The pod's fact obeys the same contract a producer's does.
    expect(checkDevLoopPayload(r.type, r.data)).toEqual({
      contract: true,
      ok: true,
    });
  });

  it.each(["rolled_back", "rollback_failed", "failed", "aborted", "noop"])(
    "records nothing for a %s update (nothing new is live)",
    async (status) => {
      const { deps, recorded } = fakeDeps();
      expect(await recordPodDeployed({ ...success, status }, deps)).toEqual({
        status: "skipped",
        reason: "not_a_success",
      });
      expect(recorded).toHaveLength(0);
    }
  );

  it("records it ONCE per update: a later boot re-reading the same outcome is a no-op", async () => {
    const seen = new Set<string>();
    const { deps, recorded } = fakeDeps({
      alreadyRecorded: async (ref) => seen.has(ref),
      record: async (input) => {
        seen.add(input.subjectRef);
        recorded.push(input);
        return { id: "ev-1" };
      },
    });
    await recordPodDeployed(success, deps);
    expect(await recordPodDeployed(success, deps)).toEqual({
      status: "skipped",
      reason: "already_recorded",
    });
    expect(recorded).toHaveLength(1);
    expect([...seen]).toEqual([podDeployedSubjectRef("u-42")]);
  });

  it("records nothing without a build sha (never a guessed one)", async () => {
    const { deps, recorded } = fakeDeps({ buildSha: () => null });
    expect(await recordPodDeployed(success, deps)).toEqual({
      status: "skipped",
      reason: "no_build_sha",
    });
    expect(recorded).toHaveLength(0);
  });

  it("never throws: a failed write is reported", async () => {
    const { deps } = fakeDeps({
      record: async () => {
        throw new Error("db down");
      },
    });
    expect(await recordPodDeployed(success, deps)).toEqual({
      status: "failed",
      error: "db down",
    });
  });
});
