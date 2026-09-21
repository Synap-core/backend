/**
 * orient `startHere.openFindings` — known blockers in Synap ITSELF, surfaced on
 * the one door every agent already calls.
 *
 * WHY A FIELD AND NOT A PLAYBOOK: a playbook only runs if the agent knows it
 * exists, and it will not. The shipped consequence of NOT having this: the
 * 2026-09-20 dogfood session concluded entity deletion was impossible and told
 * the user so, while a finding describing exactly that trap could have been
 * handed to it at session start.
 *
 * THE HONESTY RULE THIS PINS HARDEST: a failed read is `{status:"unavailable"}`,
 * NEVER an empty list. "No open blockers" and "could not check for blockers"
 * are different facts, and folding the second into the first renders a broken
 * lookup as a calm, confident all-clear — the exact defect class this repo has
 * shipped three times (`fetchPodStatus`, `[] ?? fallback`, `useProjects`).
 *
 * WHAT THIS DOES NOT COVER, measured and deliberately widened: since the read
 * moved behind `open-findings-door.js` (to stop this file needing a TOTAL
 * `@synap/database` mock), this file stubs that door outright. So it covers the
 * PROJECTION and the honesty rules only — it does NOT exercise the SQL at all.
 * Nothing here would notice if the `finding-status = 'open'` or
 * `severity = 'blocker'` predicates were dropped, the soft-delete filter removed,
 * or the `CAP + 1` probe changed to `CAP` (which would silently turn
 * `countIsLowerBound` into a permanent `false`).
 *
 * That is a REAL hole, not a shrug. It is currently covered only by the live
 * verification against the pod on 2026-09-20 (20 findings, correct
 * status/severity filtering). Closing it properly needs a pglite test driving
 * `readOpenBlockerFindings` against real rows — worth doing, not done.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    title: string | null;
    properties: Record<string, unknown> | null;
  }>,
  /** Open findings at ANY severity, as the door reports them. */
  openTotal: 0 as number,
  dbThrows: false,
  /** How many rows the caller asked the door for — proves the +1 probe. */
  requested: 0 as number,
  /** The userId the door was called with — it carries the visibility floor. */
  calledWithUserId: null as string | null,
}));

// Stub the DOOR, not `@synap/database`. A total module replacement is what the
// `database-mock-total-ratchet` tripwire counts, and it caught this file.
vi.mock("./open-findings-door.js", () => ({
  OPEN_FINDINGS_READ_CAP: 5,
  readOpenBlockerFindings: async (userId: string) => {
    h.requested += 1;
    h.calledWithUserId = userId;
    if (h.dbThrows) throw new Error("pool exhausted");
    return { blockers: h.rows, openTotal: h.openTotal };
  },
}));

vi.mock("../../routers/mcp/handlers/shared.js", () => ({
  listOpenFocusSessions: async () => [],
}));
vi.mock("../capabilities/capability-registry.js", () => ({
  listCapabilities: async () => [],
}));
vi.mock("../capabilities/action-projection.js", () => ({
  projectRunnableActions: () => [],
}));
vi.mock("./profile-ranking.js", () => ({
  USED_MOST_LIMIT: 8,
  profileDisplayName: (p: { slug: string }) => p.slug,
  rankProfilesByUsage: async () => ({ ranked: [], groups: [] }),
}));
vi.mock("../../utils/deep-links.js", () => ({
  openLink: (id: string) => `https://pod.example/open/${id}`,
}));

import { buildStartHere } from "./start-here.js";
import { OPEN_FINDINGS_READ_CAP } from "./open-findings-door.js";

const caller = { profiles: { listProfiles: async () => ({ profiles: [] }) } };

const build = () =>
  buildStartHere({
    caller: caller as never,
    userId: "u1",
    pending: { status: "unavailable" },
    learnMoreSkill: "system/synap/lenses",
  });

const finding = (
  id: string,
  props: Record<string, unknown> = {
    "finding-status": "open",
    severity: "blocker",
  }
) => ({ id, title: `finding ${id}`, properties: props });

beforeEach(() => {
  h.rows = [];
  h.openTotal = 0;
  h.dbThrows = false;
  h.requested = 0;
  h.calledWithUserId = null;
});

describe("startHere.openFindings", () => {
  it("projects id, title, link, surface and workaround", async () => {
    h.rows = [
      finding("f1", {
        "finding-status": "open",
        severity: "blocker",
        surface: "mcp",
        workaround: "use kebab-case slugs",
      }),
    ];
    h.openTotal = 1;
    const out = await build();
    expect(out.openFindings).toEqual({
      count: 1,
      countIsLowerBound: false,
      severity: "blocker",
      openTotal: 1,
      items: [
        {
          id: "f1",
          title: "finding f1",
          link: "https://pod.example/open/f1",
          surface: "mcp",
          workaround: "use kebab-case slugs",
        },
      ],
    });
  });

  it("reports a lower bound instead of silently truncating", async () => {
    h.rows = Array.from({ length: OPEN_FINDINGS_READ_CAP + 1 }, (_, i) =>
      finding(`f${i}`)
    );
    const out = await build();
    expect(out.openFindings).toMatchObject({
      count: OPEN_FINDINGS_READ_CAP,
      countIsLowerBound: true,
    });
    // The door is asked exactly once per orient — not once per item.
    expect(h.requested).toBe(1);
    // The visibility floor must actually reach the door. Dropping this argument
    // would compile (the door would just see undefined) and silently widen or
    // break the pod-scoped read.
    expect(h.calledWithUserId).toBe("u1");
  });

  /**
   * FINDING 14005d59, filed against this code by another dogfooding agent and
   * correct: `count` is SEVERITY-FILTERED while `beforeYouFinish` told agents
   * to dedupe against it. An agent checking a blocker-only list, finding no
   * twin, and filing a duplicate of an open `minor` finding would have been
   * obeying the instruction exactly. The number was true; the conclusion a
   * reader drew from it was false.
   */
  it("names the severity filter and reports the UNFILTERED open total", async () => {
    h.rows = [finding("f1")]; // one blocker…
    h.openTotal = 9; // …out of nine open findings
    const out = await build();
    expect(out.openFindings).toMatchObject({
      count: 1,
      severity: "blocker",
      openTotal: 9,
    });
    // The pairing is the point: a reader seeing `count: 1` alone concludes
    // "one open finding", which is wrong by a factor of nine.
    expect(
      (out.openFindings as { openTotal: number }).openTotal,
      "openTotal collapsed into the blocker count — the filter is invisible again"
    ).not.toBe(1);
  });

  it("the dedup instruction points past the blocker page", async () => {
    const out = await build();
    // Non-vacuity: the instruction must still exist at all.
    expect(out.beforeYouFinish.length).toBeGreaterThan(100);
    expect(
      out.beforeYouFinish,
      "the instruction still sends agents to dedupe against a filtered list"
    ).toContain("openTotal");
    expect(out.beforeYouFinish).toContain("finding");
  });

  it("nothing open is count 0 — a real, readable answer", async () => {
    const out = await build();
    expect(out.openFindings).toEqual({
      count: 0,
      countIsLowerBound: false,
      severity: "blocker",
      openTotal: 0,
      items: [],
    });
  });

  it("A FAILED READ IS 'unavailable', NEVER an empty list", async () => {
    h.dbThrows = true;
    const out = await build();
    expect(
      out.openFindings,
      "a failed blocker lookup must not brief 'no known blockers'"
    ).toEqual({ status: "unavailable" });
  });

  it("a missing surface/workaround is null, never an empty string", async () => {
    h.rows = [finding("f1")];
    const out = await build();
    expect(out.openFindings).toMatchObject({
      items: [{ surface: null, workaround: null }],
    });
  });

  it("a non-string property is treated as absent, not coerced", async () => {
    h.rows = [
      finding("f1", {
        "finding-status": "open",
        severity: "blocker",
        surface: { not: "a string" },
        workaround: 42,
      }),
    ];
    const out = await build();
    expect(out.openFindings).toMatchObject({
      items: [{ surface: null, workaround: null }],
    });
  });
});

describe("startHere.beforeYouFinish — the instruction lives in the pod", () => {
  it("is present, and asks for VERBATIM evidence", async () => {
    const out = await build();
    // The spec's load-bearing claim: this instruction cannot live in a prompt,
    // because an agent doing ordinary work is never told to file anything.
    expect(out.beforeYouFinish).toContain("finding");
    expect(
      out.beforeYouFinish,
      "the ask must demand verbatim evidence — a summarising model summarises unless told not to"
    ).toContain("VERBATIM");
    expect(out.beforeYouFinish).toContain("openFindings");
  });

  it("briefing order puts blockers right after the review queue", async () => {
    const out = await build();
    expect(Object.keys(out).slice(0, 3)).toEqual([
      "pendingReview",
      "openFindings",
      "openSessions",
    ]);
  });
});
