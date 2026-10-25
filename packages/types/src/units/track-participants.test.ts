import { describe, it, expect } from "vitest";
import {
  commitmentMoveRefusal,
  goalJudge,
  goalMayDrop,
  goalOwner,
  isOpenCommitment,
  mayStaffGoal,
  trackReportGroupKey,
  trackReportGroupKeyPrefix,
  TRACK_COMMITMENT_MOVES,
  TRACK_COMMITMENT_STATES,
  TRACK_PARTICIPANT_ROLES,
} from "./track-participants.js";
import {
  resolveTrackCommitmentStateLabel,
  resolveTrackParticipantRoleLabel,
  trackSilenceLabel,
} from "../vocabulary/index.js";

const track = { userId: "starter" };

describe("goalJudge — the one answer to who closes a goal", () => {
  it("the judge row wins; without one the owner judges; without an owner row the starter", () => {
    const owner = { role: "owner" as const, principalId: "ana" };
    const judge = { role: "judge" as const, principalId: "bob" };
    const delegate = { role: "delegate" as const, principalId: "cy" };
    expect(goalJudge([owner, judge, delegate], track)).toBe("bob");
    expect(goalJudge([owner, delegate], track)).toBe("ana");
    expect(goalJudge([delegate], track)).toBe("starter");
    expect(goalOwner([owner, judge], track)).toBe("ana");
  });

  it("owner and judge may staff a goal; a delegate may not", () => {
    const rows = [
      { role: "owner" as const, principalId: "ana" },
      { role: "judge" as const, principalId: "bob" },
      { role: "delegate" as const, principalId: "cy" },
    ];
    expect(mayStaffGoal(rows, track, "ana")).toBe(true);
    expect(mayStaffGoal(rows, track, "bob")).toBe(true);
    expect(mayStaffGoal(rows, track, "cy")).toBe(false);
  });
});

describe("goalMayDrop — F7, one rule for the pod and every Drop", () => {
  const rows = [
    { role: "owner" as const, principalId: "ana" },
    { role: "judge" as const, principalId: "bob" },
    { role: "delegate" as const, principalId: "cy" },
  ];
  const ask = (viewerId: string | null, viewerIsAgent = false) =>
    goalMayDrop({ track, participants: rows, viewerId, viewerIsAgent });
  it("the owner and the judge drop; a delegate (with write access or not) is refused", () => {
    expect(ask("ana")).toBe("allowed");
    expect(ask("bob")).toBe("allowed");
    // Rules out "anyone who can write the project drops it".
    expect(ask("cy")).toBe("refused");
    expect(ask(null)).toBe("refused");
  });
  it("an agent's drop proposes — even an agent acting for the owner", () => {
    expect(ask("ana", true)).toBe("proposes");
  });
});

describe("commitment moves", () => {
  it("accept / counter / decline from asked; impossible only from accepted", () => {
    expect(commitmentMoveRefusal("proposed", "accept")).toBeNull();
    expect(
      commitmentMoveRefusal("proposed", "counter", "Half of it")
    ).toBeNull();
    expect(commitmentMoveRefusal("proposed", "counter")).toBe(
      "Say what you would commit to instead."
    );
    expect(commitmentMoveRefusal("proposed", "report_impossible", "x")).toMatch(
      /Only an accepted commitment/
    );
    expect(commitmentMoveRefusal("accepted", "report_impossible")).toBe(
      "Say why it cannot be done."
    );
    expect(
      commitmentMoveRefusal("accepted", "report_impossible", "No access")
    ).toBeNull();
    expect(commitmentMoveRefusal("declined", "accept")).toMatch(/is declined/);
    expect(commitmentMoveRefusal(null, "accept")).toMatch(/cannot be accepted/);
  });

  it("every move lands on a real state; open commitments are the ones still owed", () => {
    for (const m of Object.values(TRACK_COMMITMENT_MOVES)) {
      expect(TRACK_COMMITMENT_STATES).toContain(m.to);
    }
    expect(isOpenCommitment("accepted")).toBe(true);
    expect(isOpenCommitment("reported_impossible")).toBe(false);
    expect(isOpenCommitment(null)).toBe(false);
  });

  it("the R10 group key carries the report time under the participant's prefix", () => {
    const key = trackReportGroupKey("p1", "2026-10-23T10:00:00Z");
    expect(key).toBe("track-report:p1:2026-10-23T10:00:00.000Z");
    expect(key.startsWith(trackReportGroupKeyPrefix("p1"))).toBe(true);
  });
});

describe("words", () => {
  it("every role and state has words; unknown values humanize", () => {
    for (const r of TRACK_PARTICIPANT_ROLES) {
      expect(resolveTrackParticipantRoleLabel(r)).not.toBe(r);
    }
    for (const s of TRACK_COMMITMENT_STATES) {
      expect(resolveTrackCommitmentStateLabel(s)).toMatch(/^[A-Z]/);
    }
    expect(resolveTrackCommitmentStateLabel("proposed")).toBe("Asked");
    expect(resolveTrackParticipantRoleLabel("co_pilot")).toBe("Co pilot");
  });

  it("silence reads 'Silent 6 h' / 'Silent 3 d', never 'stale', nothing under an hour", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(trackSilenceLabel("2026-10-23T06:00:00Z", now)).toBe("Silent 6 h");
    expect(trackSilenceLabel("2026-10-20T12:00:00Z", now)).toBe("Silent 3 d");
    expect(trackSilenceLabel("2026-10-23T11:30:00Z", now)).toBeNull();
    expect(trackSilenceLabel(null, now)).toBeNull();
  });
});
