/**
 * orient `startHere` — the briefing SHAPE and its honesty rules, through the
 * real `buildStartHere` with its door seams stubbed:
 *
 *   - pending review is the FIRST key, and carries a link to the oldest
 *     proposal (the one to review first);
 *   - an unreadable section is `{ status: "unavailable" }`, never 0 / [] —
 *     a failed sessions read must not brief "nothing is open";
 *   - top kinds are KINDS (roles excluded) with usage, and keep the rank the
 *     whole listing gave them;
 *   - the skill pointer is a slug, not a door-specific tool name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    goal: string | null;
    startedAt: Date | null;
  }>,
  sessionsThrow: false,
  capsThrow: false,
  owingThrow: false,
}));

vi.mock("../../routers/mcp/handlers/shared.js", () => ({
  listOpenFocusSessions: async (
    _userId: string,
    _limit: number,
    opts: { onError?: string }
  ) => {
    if (h.sessionsThrow) {
      if (opts?.onError === "throw") throw new Error("pool exhausted");
      return [];
    }
    return h.sessions;
  },
}));
vi.mock("../capabilities/capability-registry.js", () => ({
  listCapabilities: async () => {
    if (h.capsThrow) throw new Error("registry down");
    return [];
  },
}));
vi.mock("../capabilities/action-projection.js", () => ({
  projectRunnableActions: () => [
    { label: "Send email" },
    { label: "Search web" },
    { label: "List events" },
    { label: "Fourth" },
  ],
}));
vi.mock("./profile-ranking.js", () => ({
  USED_MOST_LIMIT: 8,
  profileDisplayName: (p: { displayName?: string; slug: string }) =>
    p.displayName ?? p.slug,
  rankProfilesByUsage: async ({
    profiles,
  }: {
    profiles: Array<{ slug: string }>;
  }) => ({
    ranked: profiles.map((p, i) => ({
      profile: p,
      rank: i + 1,
      score: p.slug === "unused" ? 0 : 10 - i,
      entityCount: p.slug === "unused" ? 0 : 3,
      lastActivityAt: null,
      origin: { origin: "core", group: "core" },
    })),
    groups: [],
  }),
}));
vi.mock("../../utils/deep-links.js", () => ({
  openLink: (id: string) => `https://pod.example/open/${id}`,
}));

// `readOpenFindings` reads through its own door. Stubbed to EMPTY (not
// throwing) so this file keeps testing the shape it is about. Deliberately a
// DOOR stub and not `vi.mock("@synap/database", …)`: a TOTAL module
// replacement is what the `database-mock-total-ratchet` tripwire counts, and
// two of them (this file and start-here-open-findings.test.ts) pushed it from
// 60 to 62. The openFindings behaviour itself is pinned in
// `start-here-open-findings.test.ts`.
vi.mock("./open-findings-door.js", () => ({
  OPEN_FINDINGS_READ_CAP: 5,
  readOpenBlockerFindings: async (_userId: string) => [],
}));

// `sessionsOwingGrade` reads through its own door; its SQL + verdict read is
// pinned on PGlite in `focus-sessions/__tests__/session-nudges.pglite.test.ts`.
vi.mock("../focus-sessions/session-nudges.js", () => ({
  listSessionsOwingGrade: async (_userId: string) => {
    if (h.owingThrow) throw new Error("pool exhausted");
    return {
      count: 1,
      countIsLowerBound: false,
      lens: "owned-open",
      items: [
        { id: "s-owe", title: "Ship W5", ungraded: 2, link: "/open/s-owe" },
      ],
    };
  },
}));

import { buildStartHere } from "./start-here.js";

const caller = {
  profiles: {
    listProfiles: async () => ({
      profiles: [
        {
          id: "p-client",
          slug: "client",
          displayName: "Client",
          profileKind: "role",
        },
        {
          id: "p-task",
          slug: "task",
          displayName: "Task",
          profileKind: "kind",
        },
        {
          id: "p-unused",
          slug: "unused",
          displayName: "Unused",
          profileKind: "kind",
        },
      ],
    }),
  },
} as never;

const build = (pending: Parameters<typeof buildStartHere>[0]["pending"]) =>
  buildStartHere({
    caller,
    userId: "u1",
    pending,
    learnMoreSkill: "system/synap/lenses",
  });

beforeEach(() => {
  h.sessions = [];
  h.sessionsThrow = false;
  h.capsThrow = false;
  h.owingThrow = false;
});

describe("startHere", () => {
  it("leads with pending review, linking the oldest proposal", async () => {
    const s = await build({
      status: "ok",
      count: 4,
      oldestDays: 6,
      oldestId: "prop-old",
    });
    expect(Object.keys(s)).toEqual([
      "pendingReview",
      // Known blockers in Synap itself come SECOND — right after the review
      // queue and before the agent's own work, because they change what the
      // agent should attempt at all.
      "openFindings",
      "openSessions",
      // Right after the agent's open work: the part of it still ungraded.
      "sessionsOwingGrade",
      "topKinds",
      "actions",
      "learnMore",
      "beforeYouFinish",
    ]);
    expect(s.pendingReview).toEqual({
      count: 4,
      oldestDays: 6,
      oldestLink: "https://pod.example/open/prop-old",
      lens: "authored",
    });
  });

  it("an unreadable pending queue is unavailable, not zero", async () => {
    const s = await build({ status: "unavailable" });
    expect(s.pendingReview).toEqual({ status: "unavailable" });
  });

  it("names the newest open work session and flags a capped count", async () => {
    h.sessions = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      goal: i === 0 ? "Ship W4" : null,
      startedAt: new Date("2026-09-14T08:00:00Z"),
    }));
    const s = await build({ status: "ok", count: 0, oldestDays: 0 });
    expect(s.openSessions).toMatchObject({
      count: 10,
      countIsLowerBound: true,
      newest: { id: "s0", goal: "Ship W4" },
    });
  });

  it("a failed sessions read is unavailable — never '0 open'", async () => {
    h.sessionsThrow = true;
    const s = await build({ status: "ok", count: 0, oldestDays: 0 });
    expect(s.openSessions).toEqual({ status: "unavailable" });
  });

  it("top kinds exclude roles and unused kinds, and keep the listing rank", async () => {
    const s = await build({ status: "ok", count: 0, oldestDays: 0 });
    expect(s.topKinds).toEqual([
      {
        slug: "task",
        name: "Task",
        entityCount: 3,
        lastActivityAt: null,
        rank: 2,
      },
    ]);
  });

  it("actions: count + three examples + the lens they were read at; failure is unavailable", async () => {
    const s = await build({ status: "ok", count: 0, oldestDays: 0 });
    expect(s.actions).toEqual({
      count: 4,
      examples: ["Send email", "Search web", "List events"],
      lens: "pod",
    });
    h.capsThrow = true;
    expect(
      (await build({ status: "ok", count: 0, oldestDays: 0 })).actions
    ).toEqual({
      status: "unavailable",
    });
  });

  it("sessionsOwingGrade states its lens; a failed read is unavailable, never 0", async () => {
    const s = await build({ status: "ok", count: 0, oldestDays: 0 });
    expect(s.sessionsOwingGrade).toMatchObject({
      count: 1,
      lens: "owned-open",
      items: [{ id: "s-owe", ungraded: 2 }],
    });
    h.owingThrow = true;
    expect(
      (await build({ status: "ok", count: 0, oldestDays: 0 }))
        .sessionsOwingGrade
    ).toEqual({ status: "unavailable" });
  });

  it("an empty queue still states its lens", async () => {
    const s = await build({ status: "ok", count: 0, oldestDays: 0 });
    expect(s.pendingReview).toEqual({ count: 0, lens: "authored" });
  });
});
