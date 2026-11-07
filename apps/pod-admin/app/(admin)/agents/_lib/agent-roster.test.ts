import { describe, expect, it } from "vitest";
import { AGENT_BINDING_ERROR_CODES } from "@synap-core/types/agents";
import {
  agentReviewHref,
  agentsByCreator,
  agentWakeLine,
  agentWakeSource,
  agentWakeView,
  buildAgentRoster,
  hostComputerHref,
  keyCountsLine,
  originLine,
  reachErrorSentence,
  standingLine,
  viaSynapAccount,
  type AgentRosterRowLike,
  type AgentWakeRowLike,
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

  it("names the computer it runs on instead of its key's host label", () => {
    const v = only(
      row({
        activeKeys: 1,
        lastSeenAt: "2026-10-11T12:00:00Z",
        host: "cli:devbox-01",
        hostComputer: { id: "c1", name: "Build box" },
      })
    );
    expect(v.sentence).toBe("Seen 1d ago on Build box.");
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

  it("a Synap account agent says so, whatever created_via the pod recorded (review bf96d410, lane B)", () => {
    expect(originLine("cli", "synap:account")).toMatch(/Synap account/);
    expect(originLine("cli", "antoine")).toMatch(/synap init/);
    expect(viaSynapAccount(row({ hostSeat: "synap:account" }))).toBe(true);
    expect(viaSynapAccount(row({ hostSeat: null }))).toBe(false);
    const [view] = buildAgentRoster(
      [row({ hostSeat: "synap:account" })],
      [],
      null,
      () => "now"
    );
    expect(view!.sentence).toMatch(/Through your Synap account\.$/);
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

describe("agentReviewHref", () => {
  it("prefers the pending keys' approval page", () => {
    expect(
      agentReviewHref(
        row({
          approveUrl: "https://pod.example/approve-agents?keys=k1",
          pendingProposalId: "p1",
        })
      )
    ).toBe("https://pod.example/approve-agents?keys=k1");
  });

  it("falls back to its connect request in Review's Access view", () => {
    expect(agentReviewHref(row({ pendingProposalId: "p1" }))).toBe(
      "/review?type=access&focus=p1"
    );
    expect(agentReviewHref(row({}))).toBe("/review?type=access");
  });
});

describe("hostComputerHref", () => {
  it("opens the computer it runs on; null off a computer", () => {
    expect(
      hostComputerHref(row({ hostComputer: { id: "c 1", name: "devbox" } }))
    ).toBe("/computers/c%201");
    expect(hostComputerHref(row({ hostComputer: null }))).toBeNull();
    expect(hostComputerHref(row({}))).toBeNull();
  });
});

describe("reachErrorSentence", () => {
  it("words every known code and never leaks an unknown one", () => {
    const fallback = reachErrorSentence(undefined);
    for (const code of AGENT_BINDING_ERROR_CODES) {
      expect(reachErrorSentence(code)).not.toBe(fallback);
    }
    expect(reachErrorSentence("tool_inactive")).toBe(
      "The connector it was set up with is turned off."
    );
    expect(reachErrorSentence("something_new")).toBe(
      "The pod cannot reach it through its connector."
    );
    expect(reachErrorSentence(null)).toBe(
      "The pod cannot reach it through its connector."
    );
  });
});

describe("buildAgentRoster — a paused agent", () => {
  it("reads Paused and says it takes no work", () => {
    const v = only(
      row({
        activeKeys: 1,
        lastSeenAt: "2026-10-11T12:00:00Z",
        pausedAt: "2026-10-12T08:00:00Z",
      })
    );
    expect(v.status).toEqual({ kind: "stale", label: "Paused" });
    expect(v.sentence).toBe("Paused: it takes no work. Seen 1d ago.");
  });

  it("a waiting key still outranks the pause", () => {
    const v = only(
      row({ activeKeys: 1, pendingKeys: 1, pausedAt: "2026-10-12T08:00:00Z" })
    );
    expect(v.status.label).toBe("Needs approval");
  });

  it("null pausedAt is not paused", () => {
    const v = only(
      row({ activeKeys: 1, lastSeenAt: "2026-10-11T12:00:00Z", pausedAt: null })
    );
    expect(v.status.label).toBe("Active");
    expect(v.sentence).not.toContain("Paused");
  });
});

describe("agentWakeView — the pod's wake read, in words, with the fix's door", () => {
  const claude = {
    slug: "claude-code",
    label: "Claude Code",
    version: "0.26.0",
  };
  const read = (agents: AgentWakeRowLike[]) =>
    agentWakeSource({ isLoading: false, isError: false, data: { agents } });
  const cant = (why: AgentWakeRowLike["wake"]["why"]) => ({
    state: "cant_wake" as const,
    how: null,
    why,
  });

  it("no computer: the reason, the fix, and the worker command with its name", () => {
    const v = agentWakeView(
      row({}),
      read([{ agentUserId: "a1", template: claude, wake: cant("no_computer") }])
    );
    expect(v).toMatchObject({
      kind: "known",
      template: "Claude Code",
      state: "Can't wake",
      cantWake: true,
      why: "No computer",
      command: "synap worker --agent devbox-worker",
      fixHref: null,
    });
    expect(v.kind === "known" && v.fix).toMatch(/Run the Synap worker/);
    expect(agentWakeLine(v)).toBe("Claude Code · Can't wake: No computer");
  });

  it("computer offline: the door is its computer's page, no command", () => {
    const v = agentWakeView(
      row({ hostComputer: { id: "c1", name: "mac" } }),
      read([
        { agentUserId: "a1", template: claude, wake: cant("computer_offline") },
      ])
    );
    expect(v).toMatchObject({ kind: "known", command: null });
    expect(v.kind === "known" && v.fixHref).toBe(
      hostComputerHref(row({ hostComputer: { id: "c1", name: "mac" } }))
    );
  });

  it("no template: says so by name, and points at the catalog", () => {
    const v = agentWakeView(
      row({}),
      read([{ agentUserId: "a1", template: null, wake: cant("no_template") }])
    );
    expect(agentWakeLine(v)).toBe(
      "No agent template · Can't wake: No agent template"
    );
    expect(v.kind === "known" && v.fix).toMatch(/Marketplace/);
  });

  it("awake: the state only, no reason, no fix", () => {
    const v = agentWakeView(
      row({}),
      read([
        {
          agentUserId: "a1",
          template: claude,
          wake: { state: "awake", how: "runner", why: null },
        },
      ])
    );
    expect(v).toMatchObject({
      kind: "known",
      cantWake: false,
      why: null,
      fix: null,
      command: null,
    });
    expect(agentWakeLine(v)).toBe("Claude Code · Awake");
  });

  it("a failed read is unavailable, never can't wake; loading or unlisted is unknown", () => {
    expect(
      agentWakeView(
        row({}),
        agentWakeSource({ isLoading: false, isError: true })
      )
    ).toEqual({ kind: "unavailable" });
    expect(
      agentWakeView(
        row({}),
        agentWakeSource({ isLoading: true, isError: false })
      )
    ).toEqual({ kind: "unknown" });
    expect(agentWakeView(row({ id: "other" }), read([]))).toEqual({
      kind: "unknown",
    });
    expect(agentWakeLine({ kind: "unavailable" })).toBeNull();
  });
});
