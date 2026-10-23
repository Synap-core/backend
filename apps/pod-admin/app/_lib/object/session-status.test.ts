import { describe, expect, it } from "vitest";
import {
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import {
  criterionRows,
  deliverableRows,
  draftSummary,
  moveNotice,
  sessionMoves,
  sessionRoom,
  sessionStarter,
  sessionStatusMark,
  type SessionMoves,
} from "./session-status";

const draft = { pending: true };
const accepted = { pending: false };

/** "primary · more, more" — the shape a reader sees in the header. */
function shape(m: SessionMoves): string {
  return [m.primary?.key ?? "-", m.more.map((x) => x.key).join(",")].join(
    " · "
  );
}

describe("sessionStatusMark — a draft is its own mark", () => {
  it("marks a draft Drafted, dashed, whatever its stored status", () => {
    for (const status of ["active", "forming", "paused", "scheduled"]) {
      const mark = sessionStatusMark({ status, triage: draft });
      expect(mark).toEqual({
        kind: "stale",
        label: "Drafted",
        glyph: "draft",
        draft: true,
      });
    }
  });

  it("never draws an accepted session like a draft", () => {
    const mark = sessionStatusMark({ status: "active", triage: accepted })!;
    expect(mark.draft).toBe(false);
    expect(mark.label).toBe("Active");
    expect(mark.glyph).toBe("moving");
    expect(mark.label).not.toBe(
      sessionStatusMark({ status: "active", triage: draft })!.label
    );
  });

  it("gives every stored status a word from the vocabulary and a glyph", () => {
    for (const status of SESSION_STATUSES) {
      const mark = sessionStatusMark({ status })!;
      expect(mark.label).toBeTruthy();
      expect(mark.label).not.toBe(status);
      expect(mark.glyph).not.toBeNull();
      expect(mark.glyph).not.toBe("draft");
    }
  });

  it("keeps the dot for a status this build does not know", () => {
    expect(sessionStatusMark({ status: "teleported" })!.glyph).toBeNull();
    expect(sessionStatusMark({ status: "" })).toBeNull();
  });
});

describe("sessionMoves — the next move first, the rest in the menu", () => {
  const owner = (status: string, triage = accepted) =>
    shape(sessionMoves({ status, triage, viewerRole: "owner" }));

  it("offers Accept on a draft, and Discard beside it — nothing else", () => {
    for (const status of ["active", "forming", "paused", "scheduled"]) {
      expect(owner(status, draft)).toBe("accept · discard");
    }
  });

  it("moves each open status forward", () => {
    expect(owner("active")).toBe("close · pause,cancel");
    expect(owner("forming")).toBe("close · pause,cancel");
    expect(owner("paused")).toBe("resume · close,cancel");
    expect(owner("stale")).toBe("resume · close,cancel");
    expect(owner("scheduled")).toBe("start · cancel");
  });

  it("offers no move on an ended session", () => {
    for (const status of TERMINAL_SESSION_STATUSES) {
      expect(owner(status)).toBe("- · ");
    }
  });

  it("offers a member of a shared session nothing, draft or not", () => {
    for (const viewerRole of ["member", null, undefined]) {
      expect(
        shape(sessionMoves({ status: "active", triage: draft, viewerRole }))
      ).toBe("- · ");
      expect(shape(sessionMoves({ status: "paused", viewerRole }))).toBe(
        "- · "
      );
    }
  });

  it("names each move's door, and only plain flips go through update", () => {
    const all = [
      sessionMoves({ status: "active", triage: draft, viewerRole: "owner" }),
      sessionMoves({ status: "active", viewerRole: "owner" }),
      sessionMoves({ status: "paused", viewerRole: "owner" }),
      sessionMoves({ status: "scheduled", viewerRole: "owner" }),
    ].flatMap((m) => [m.primary!, ...m.more]);
    const doors = Object.fromEntries(
      all.map((m) => [m.key, [m.door, m.toStatus ?? null, m.confirm]])
    );
    expect(doors).toEqual({
      accept: ["acceptFromTriage", null, false],
      discard: ["discardFromTriage", null, true],
      start: ["update", "active", false],
      pause: ["update", "paused", false],
      resume: ["update", "active", false],
      close: ["close", null, true],
      cancel: ["cancel", null, true],
    });
  });

  it("labels each move with the vocabulary's verb", () => {
    const m = sessionMoves({
      status: "active",
      triage: draft,
      viewerRole: "owner",
    });
    expect(m.primary!.label).toBe("Accept");
    expect(m.more[0]!.label).toBe("Discard");
  });
});

describe("sessionStarter", () => {
  it("names the agent at the head of the roster, as the pod resolved it", () => {
    expect(
      sessionStarter({
        origin: "agent",
        agentIds: ["a1", "a2"],
        participants: [
          { id: "a2", name: "Codex" },
          { id: "a1", name: "Claude Code on devbox" },
        ],
      })
    ).toEqual({ by: "agent", id: "a1", name: "Claude Code on devbox" });
  });

  it("says who else could have started it, and guesses nothing", () => {
    expect(sessionStarter({ origin: "human", viewerRole: "owner" })).toEqual({
      by: "person",
      you: true,
    });
    expect(
      sessionStarter({ origin: "automation", metadata: { automationId: "r1" } })
    ).toEqual({ by: "automation", id: "r1" });
    expect(sessionStarter({ origin: "playbook", playbookId: "p1" })).toEqual({
      by: "playbook",
      id: "p1",
    });
    expect(sessionStarter({ origin: null })).toBeNull();
    expect(sessionStarter({ origin: "agent", agentIds: [] })).toEqual({
      by: "agent",
      id: null,
      name: null,
    });
  });

  it("says what accepting a draft does", () => {
    const agent = { by: "agent" as const, id: "a1", name: "Claude Code" };
    expect(draftSummary(agent, true)).toBe(
      "Claude Code started this as a draft. Its run waits until you accept it."
    );
    expect(draftSummary({ by: "automation", id: null }, false)).toMatch(
      /^An automation started this as a draft\. Accept it/
    );
  });
});

describe("deliverables and criteria", () => {
  it("counts only the pod's done stamp, never an agent's claim", () => {
    expect(
      deliverableRows([
        { key: "brief", label: "Brief", status: "done" },
        { label: "Draft", claimedDone: true },
        { label: "  " },
        "junk",
      ])
    ).toEqual([
      { key: "brief", label: "Brief", done: true },
      { key: "1", label: "Draft", done: false },
    ]);
    expect(deliverableRows(null)).toEqual([]);
  });

  it("pairs each criterion with its current verdict", () => {
    expect(
      criterionRows(
        [
          { key: "tests", statement: "Tests pass" },
          { key: "docs", statement: "Docs updated", required: false },
        ],
        [{ criterionKey: "tests", verdict: "fail" }]
      )
    ).toEqual([
      {
        key: "tests",
        statement: "Tests pass",
        verdict: "fail",
        required: true,
      },
      {
        key: "docs",
        statement: "Docs updated",
        verdict: null,
        required: false,
      },
    ]);
  });
});

describe("sessionRoom — no room, a failed read and an empty room are three facts", () => {
  const people = [{ id: "a1", name: "Claude Code" }];

  it("omits a session with no room", () => {
    expect(sessionRoom(undefined, null, people, true)).toEqual({
      state: "none",
    });
    expect(
      sessionRoom(
        { status: "ok", channelId: null, items: [], hasMore: false },
        null,
        people,
        true
      )
    ).toEqual({ state: "none" });
  });

  it("keeps the room's door when its messages could not be read", () => {
    expect(
      sessionRoom({ status: "unavailable", reason: "x" }, "c1", people, true)
    ).toEqual({ state: "failed", channelId: "c1" });
  });

  it("reads the newest message, named for the viewer", () => {
    const room = sessionRoom(
      {
        status: "ok",
        channelId: "c1",
        items: [
          {
            id: "m2",
            at: "2026-10-23T10:00:00.000Z",
            author: "agent",
            agentUserId: "a1",
            text: "Done with step 2",
          },
          {
            id: "m1",
            at: "2026-10-23T09:00:00.000Z",
            author: "person",
            text: "Go",
          },
        ],
        hasMore: false,
      },
      "c1",
      people,
      true
    );
    expect(room).toEqual({
      state: "ok",
      channelId: "c1",
      lastAt: "2026-10-23T10:00:00.000Z",
      latest: { author: "Claude Code", text: "Done with step 2" },
    });
    expect(
      sessionRoom(
        { status: "ok", channelId: "c1", items: [], hasMore: false },
        "c1",
        people,
        true
      )
    ).toEqual({ state: "ok", channelId: "c1", lastAt: null, latest: null });
  });
});

describe("moveNotice — only what the new mark cannot say", () => {
  it("reports a held run, a lost race and withdrawn proposals", () => {
    expect(
      moveNotice("acceptFromTriage", {
        accepted: true,
        heldRun: { status: "started", runId: "r" },
      })
    ).toEqual({ text: "Accepted. Its run has started.", warning: false });
    expect(
      moveNotice("acceptFromTriage", {
        accepted: true,
        heldRun: { status: "failed" },
      })?.warning
    ).toBe(true);
    expect(moveNotice("acceptFromTriage", { accepted: true })).toBeNull();
    expect(
      moveNotice("acceptFromTriage", { accepted: false, reason: "not_pending" })
        ?.text
    ).toBe("This draft was already decided.");
    expect(
      moveNotice("discardFromTriage", { discarded: true, expiredEphemerals: 2 })
        ?.text
    ).toBe("Discarded. 2 changes it proposed were withdrawn.");
    expect(
      moveNotice("close", { warnings: ["2 criteria are not met."] })
    ).toEqual({ text: "2 criteria are not met.", warning: true });
    expect(moveNotice("update", { status: "paused" })).toBeNull();
  });
});
