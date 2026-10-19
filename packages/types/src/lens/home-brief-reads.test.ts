/**
 * The Home brief's reads → input, and the Home sections' rows — shared by the
 * desktop and relay. Each case names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  HOME_MOVES_CAP,
  homeBriefInputOf,
  homeBriefSince,
  homeMoves,
  liveSessionCount,
  resolveHomeLastSeen,
  projectStandRows,
  projectStandLensRow,
  type HomeBriefReads,
} from "./home-brief-reads.js";

const ready = <T>(data: T) => ({ status: "ready" as const, data });

const READS: HomeBriefReads = {
  lastSeen: "2026-10-18T19:40:00.000Z",
  needsYou: ready({
    counts: { decision: 3, question: 1, routine: 14, broken: 1 },
    capped: false,
  }),
  produced: ready({
    items: [1, 2, 3, 4, 5, 6, 7, 8],
    nextCursor: null,
    truncated: false,
  }),
  projectCounts: ready([
    { status: "ok", count: { needsYou: 2 } },
    { status: "ok", count: { needsYou: 0 } },
    { status: "ok", count: { needsYou: 1 } },
  ]),
  moving: ready({ items: [], unattached: [] }),
};

describe("homeBriefInputOf — Home reads → the shared brief input", () => {
  it("counts each clause from its own read", () => {
    expect(homeBriefInputOf(READS)).toEqual({
      since: "last-seen",
      produced: { count: 8, floor: false },
      decisions: { count: 3, floor: false },
      questions: { count: 1, floor: false },
      failed: { count: 1, floor: false },
      // Rules out "projects = needs-you rows": two of three projects wait.
      projectsHeldUp: { count: 2 },
      working: { count: 0 },
    });
  });

  it("a read in flight holds the whole sentence (rules out: speak from half the counts)", () => {
    expect(
      homeBriefInputOf({ ...READS, produced: { status: "loading" } })
    ).toBeNull();
  });

  it('a failed read is unknown, never 0; an unavailable project count makes "held up" unknown', () => {
    const input = homeBriefInputOf({
      ...READS,
      produced: { status: "failed" },
      projectCounts: ready([
        { status: "ok", count: { needsYou: 2 } },
        { status: "unavailable" },
      ]),
    })!;
    expect(input.produced).toEqual({ count: null });
    expect(input.projectsHeldUp).toEqual({ count: null });
  });

  it("a capped page and a paged landed read are floors", () => {
    const input = homeBriefInputOf({
      ...READS,
      needsYou: ready({
        counts: { decision: 90, question: 10, routine: 0, broken: 0 },
        capped: true,
      }),
      produced: ready({ items: [1], nextCursor: "c", truncated: false }),
    })!;
    expect(input.decisions).toEqual({ count: 90, floor: true });
    expect(input.produced).toEqual({ count: 1, floor: true });
  });

  it("no last visit counts today, from the day start", () => {
    expect(homeBriefInputOf({ ...READS, lastSeen: null })!.since).toBe("today");
    expect(homeBriefSince(null, Date.parse("2026-10-19T00:00:00.000Z"))).toBe(
      "2026-10-19T00:00:00.000Z"
    );
  });
});

describe("liveSessionCount", () => {
  it("a session counts once wherever it shows, and only while live", () => {
    expect(
      liveSessionCount({
        items: [
          {
            work: [
              { sessionId: "s1", live: true },
              { sessionId: "s2", live: false },
            ],
          },
          { work: [{ sessionId: "s1", live: true }] },
        ],
        unattached: [{ sessionId: "s3", live: true }],
      })
    ).toBe(2);
  });
});

describe("homeMoves — the Inbox head", () => {
  const row = (
    key: string,
    bucket: "decision" | "question" | "routine" | "broken"
  ) => ({
    row: { key } as never,
    signal: {} as never,
    bucket,
  });
  it("the first three non-routine rows, in the Inbox order; routine counted for its batch line", () => {
    const m = homeMoves({
      rows: [
        row("d1", "decision"),
        row("q1", "question"),
        row("b1", "broken"),
        row("q2", "question"),
        row("r1", "routine"),
      ],
      counts: { decision: 1, question: 2, routine: 1, broken: 1 },
    });
    expect(m.moves.map((r) => r.row.key)).toEqual(["d1", "q1", "b1"]);
    expect(m.moves).toHaveLength(HOME_MOVES_CAP);
    expect(m.routine).toBe(1);
  });

  it("routine changes never fill a move slot, even when fewer than three other rows wait", () => {
    // Rules out "the first three rows": routine sorts last, so only a short
    // list lets it reach the head — exactly where it must stay a batch line.
    const m = homeMoves({
      rows: [row("d1", "decision"), row("r1", "routine"), row("r2", "routine")],
      counts: { decision: 1, question: 0, routine: 2, broken: 0 },
    });
    expect(m.moves.map((r) => r.row.key)).toEqual(["d1"]);
    expect(m.routine).toBe(2);
  });
});

describe("projectStandRows — one row per project, the shared rules decide", () => {
  const projects = [
    { id: "quiet", name: "Quiet one" },
    { id: "busy", name: "Busy one" },
    { id: "waits", name: "Waits on you" },
  ];
  const counts = ready([
    { projectId: "quiet", status: "ok", count: { needsYou: 0 } },
    { projectId: "busy", status: "ok", count: { needsYou: 0 } },
    {
      projectId: "waits",
      status: "ok",
      count: { needsYou: 3, truncated: true },
    },
  ]);
  const sessions = ready([
    // No `live` = an older pod: the one project rule reads it as working.
    {
      id: "s1",
      projectId: "busy",
      status: "active",
      title: "Draft the launch post",
    },
  ]);

  it("waiting first (the Inbox number, N+), then working, then quiet", () => {
    const rows = projectStandRows(projects, counts, sessions);
    expect(rows.map((r) => r.project.id)).toEqual(["waits", "busy", "quiet"]);
    expect(rows[0]).toMatchObject({
      state: { owedFromYou: 3 },
      nextLine: "3+ need you",
    });
    expect(rows[1]!.state.running).toBe(true);
    expect(rows[1]!.nextLine).toBe("Draft the launch post");
    // Rules out "no open session ⇒ not started": a quiet project is idle.
    expect(rows[2]).toMatchObject({ state: { idle: true }, nextLine: null });
  });

  it("an unread count is unmeasured, never quiet", () => {
    const rows = projectStandRows(
      projects,
      ready([{ projectId: "quiet", status: "unavailable" }]),
      sessions
    );
    expect(rows.find((r) => r.project.id === "quiet")!.state).toEqual({
      unreadable: true,
    });
    expect(
      projectStandRows(projects, { status: "failed" }, sessions).every(
        (r) => r.state.unreadable
      )
    ).toBe(true);
  });
});

describe("resolveHomeLastSeen — the pod's stamp wins; a failed read is not a first visit", () => {
  const POD = "2026-10-19T08:00:00.000Z";
  const DEV = "2026-10-18T19:40:00.000Z";
  const loading = { status: "loading" as const };
  const failed = { status: "failed" as const };

  it("uses the pod's stamp over a different device stamp (it follows the person)", () => {
    expect(resolveHomeLastSeen(ready(POD), ready(DEV))).toEqual({
      status: "ready",
      lastSeen: POD,
      source: "pod",
    });
  });
  it("waits for the pod rather than count over the device window first", () => {
    expect(resolveHomeLastSeen(loading, ready(DEV))).toEqual({
      status: "loading",
    });
  });
  it("a pod that never stamped falls to the device stamp (before the pod kept it)", () => {
    expect(resolveHomeLastSeen(ready(null), ready(DEV))).toEqual({
      status: "ready",
      lastSeen: DEV,
      source: "device",
    });
  });
  it("a FAILED pod read with no device stamp is 'no last seen' (today), not a window", () => {
    expect(resolveHomeLastSeen(failed, ready(null))).toEqual({
      status: "ready",
      lastSeen: null,
      source: "none",
    });
  });
  it("a failed pod read offline-falls back to the device stamp", () => {
    expect(resolveHomeLastSeen(failed, ready(DEV)).status).toBe("ready");
    expect(resolveHomeLastSeen(failed, ready(DEV))).toMatchObject({
      lastSeen: DEV,
      source: "device",
    });
  });
  it("waits for the device read only when the pod could not answer for itself", () => {
    expect(resolveHomeLastSeen(failed, loading)).toEqual({ status: "loading" });
    expect(resolveHomeLastSeen(ready(POD), loading)).toMatchObject({
      source: "pod",
    });
  });
  it("a junk stamp reads as none, never a wrong window", () => {
    expect(resolveHomeLastSeen(ready("garbage"), ready("nope"))).toMatchObject({
      lastSeen: null,
      source: "none",
    });
  });
});

describe("projectStandLensRow — ONE project row for Home and every projects index", () => {
  it("a project waiting on the person is blocking (a 'happening for all' rule misses it), its door is the project", () => {
    const row = projectStandLensRow({
      project: { id: "p1", name: "Launch" },
      state: { owedFromYou: 2 },
      nextLine: "2 need you",
    });
    expect(row).toMatchObject({
      key: "p1",
      cls: "blocking",
      objectKind: "project",
      title: "Launch",
      reason: "2 need you",
      door: { kind: "project", id: "p1" },
      verb: null,
      count: 1,
    });
  });

  it("a working or quiet project is happening, with the state passed through unchanged", () => {
    const state = { running: true } as const;
    const row = projectStandLensRow({ project: { id: "p2", name: "Site" }, state, nextLine: null });
    expect(row.cls).toBe("happening");
    expect(row.state).toBe(state);
    expect(row.reason).toBeNull();
  });
});
