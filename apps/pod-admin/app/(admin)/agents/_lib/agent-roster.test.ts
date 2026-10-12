import { describe, expect, it } from "vitest";
import {
  agentsByCreator,
  buildAgentRoster,
  keyCountsLine,
  originLine,
  standingLine,
  type AgentRosterRowLike,
} from "./agent-roster";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const rel = (iso: string) =>
  `${Math.round((NOW - Date.parse(iso)) / 86_400_000)}d ago`;

const row = (over: Partial<AgentRosterRowLike>): AgentRosterRowLike => ({
  id: "a1",
  name: "devbox-worker",
  lastSeenAt: null,
  host: null,
  activeKeys: 0,
  pendingKeys: 0,
  revokedKeys: 0,
  origin: "cli",
  createdByUserId: "u-owner",
  ...over,
});

function only(r: AgentRosterRowLike, viewer: string | null = "u-owner") {
  return buildAgentRoster([r], [], viewer, rel, NOW)[0]!;
}

describe("buildAgentRoster — status and sentence", () => {
  it("recently seen: healthy, says when and where", () => {
    const v = only(
      row({
        activeKeys: 1,
        lastSeenAt: "2026-10-11T12:00:00Z",
        host: "cli:devbox-01",
      })
    );
    expect(v.status).toEqual({ kind: "healthy", label: "Active" });
    expect(v.sentence).toBe("Seen 1d ago on devbox-01.");
    expect(v.needsReview).toBe(false);
  });

  it("seen long ago: quiet, never green", () => {
    const v = only(row({ activeKeys: 1, lastSeenAt: "2026-09-30T12:00:00Z" }));
    expect(v.status).toEqual({ kind: "stale", label: "Quiet" });
    expect(v.sentence).toBe("Quiet — seen 12d ago.");
  });

  it("only key pending: needs approval, the row's action is Review", () => {
    const v = only(row({ pendingKeys: 1 }));
    expect(v.status).toEqual({ kind: "stale", label: "Needs approval" });
    expect(v.sentence).toBe("Waiting for your approval before it can connect.");
    expect(v.needsReview).toBe(true);
  });

  it("a live agent with another key waiting still asks for review", () => {
    const v = only(
      row({
        activeKeys: 1,
        pendingKeys: 1,
        lastSeenAt: "2026-10-11T12:00:00Z",
      })
    );
    expect(v.needsReview).toBe(true);
    expect(v.status.label).toBe("Needs approval");
    expect(v.sentence).toBe(
      "Seen 1d ago. Another key is waiting for your approval."
    );
  });

  it("an open connect request needs review even with no pending key", () => {
    expect(only(row({ pendingProposalId: "p1" })).needsReview).toBe(true);
  });

  it("revoked keys only: disconnected, down", () => {
    const v = only(row({ revokedKeys: 2, lastSeenAt: "2026-10-09T12:00:00Z" }));
    expect(v.status).toEqual({ kind: "down", label: "Disconnected" });
    expect(v.sentence).toBe("Disconnected — no live key. Last seen 3d ago.");
  });

  it("a live key never used is waiting; no key at all is noKey", () => {
    expect(only(row({ activeKeys: 1 })).sentence).toBe(
      "Has a key but has not called the pod yet."
    );
    expect(only(row({})).sentence).toBe("Never connected — it has no key yet.");
  });

  it("built-in agents are the pod's own", () => {
    const v = only(row({ builtIn: true, origin: "system" }));
    expect(v.status).toEqual({ kind: "unknown", label: "Built-in" });
    expect(v.direction).toBe("house");
  });
});

describe("buildAgentRoster — join and order", () => {
  it("joins standings on agentUserId and marks ownership by viewer", () => {
    const [v] = buildAgentRoster(
      [row({ id: "a1" })],
      [
        {
          agentUserId: "a1",
          approveRate: 0.5,
          refuseRate: 0.5,
          scoredTotal: 4,
        },
      ],
      "u-owner",
      rel,
      NOW
    );
    expect(v!.standing?.scoredTotal).toBe(4);
    expect(v!.ownedByViewer).toBe(true);
    expect(only(row({}), "someone-else").ownedByViewer).toBe(false);
    expect(only(row({ createdByUserId: null }), null).ownedByViewer).toBe(
      false
    );
  });

  it("puts rows that wait on a person first, then most recently seen", () => {
    const views = buildAgentRoster(
      [
        row({ id: "old", activeKeys: 1, lastSeenAt: "2026-10-01T00:00:00Z" }),
        row({ id: "new", activeKeys: 1, lastSeenAt: "2026-10-12T00:00:00Z" }),
        row({ id: "pending", pendingKeys: 1 }),
      ],
      [],
      null,
      rel,
      NOW
    );
    expect(views.map((v) => v.row.id)).toEqual(["pending", "new", "old"]);
  });
});

describe("lines", () => {
  it("standingLine needs at least one decision", () => {
    expect(standingLine(null)).toBeNull();
    expect(
      standingLine({
        agentUserId: "a",
        approveRate: 0,
        refuseRate: 0,
        scoredTotal: 0,
      })
    ).toBeNull();
    expect(
      standingLine({
        agentUserId: "a",
        approveRate: 0.7931,
        refuseRate: 0.2,
        scoredTotal: 1318,
      })
    ).toBe("79% approved of 1318 reviewed");
  });

  it("keyCountsLine shows only what exists", () => {
    expect(keyCountsLine(row({ activeKeys: 2, revokedKeys: 1 }))).toBe(
      "2 live · 1 revoked"
    );
    expect(keyCountsLine(row({}))).toBe("No keys");
  });

  it("originLine words known origins and stays silent otherwise", () => {
    expect(originLine("cli")).toMatch(/synap init/);
    expect(originLine(null)).toBeNull();
    expect(originLine("martian")).toBeNull();
  });

  it("agentsByCreator lists what removeByUserId would take", () => {
    const rows = [
      row({ id: "a", createdByUserId: "u1" }),
      row({ id: "b", createdByUserId: "u2" }),
      row({ id: "c", createdByUserId: "u1" }),
    ];
    expect(agentsByCreator(rows, "u1").map((r) => r.id)).toEqual(["a", "c"]);
  });
});
