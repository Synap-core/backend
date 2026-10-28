import { describe, expect, it } from "vitest";

import { checkDevLoopPayload } from "../events/dev-loop.js";
import {
  CHECK_VERDICT_LABELS,
  REPO_MAIN_HEALTH_LABELS,
  SHIP_FOLD_LABELS,
  SHIP_STAGE_LABELS,
} from "../vocabulary/index.js";
import {
  CHECK_VERDICTS,
  REPO_MAIN_HEALTHS,
  REPO_SNAPSHOT_EVENT_TYPE,
  SHIP_FOLDS,
  SHIP_STAGES,
  checkVerdictOf,
  foldWorkRelease,
  repoSnapshotEventSchema,
  shipFoldOf,
  shipStageOf,
  type RepoSnapshotFact,
  type WorkReleaseRead,
} from "./index.js";

// ── Tonight's real shape (27 Oct 2026) ──────────────────────────────────────
// backend main red since #344, #363 fixes it, 13 PRs inherit its red;
// browser main red waiting on backend #278; app main red waiting on #337.

const NOW = Date.UTC(2026, 9, 27, 21, 0);
const min = (m: number) => new Date(NOW - m * 60_000).toISOString();
const SHA = (n: number) => n.toString(16).padStart(40, "a");
const BE = "Synap-core/backend";
const BR = "Synap-core/browser";
const APP = "Synap-core/app-bases";
const S_363 = "11111111-1111-4111-8111-111111111111";
const S_278 = "22222222-2222-4222-8222-222222222222";
const S_OTHER = "33333333-3333-4333-8333-333333333333";

type Pr = RepoSnapshotFact["prs"][number];
function pr(repo: string, number: number, over: Partial<Pr> = {}): Pr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headSha: SHA(number),
    draft: false,
    author: "Antoinesrvt",
    updatedAt: min(20),
    mergeable: "blocked",
    checks: "red",
    redInheritedFromMain: true,
    autoMerge: true,
    ...over,
  };
}

/** The 11 inherited backend PRs besides #278 and #337. */
const OTHER_INHERITED = [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310];

function backend(over: Partial<RepoSnapshotFact> = {}): RepoSnapshotFact {
  return {
    repo: BE,
    observedAt: min(2),
    visibility: "public",
    main: {
      sha: SHA(1),
      health: "red",
      source: "github-checks",
      redSince: { sha: SHA(344), prNumber: 344, at: min(300) },
      reason: "typecheck: proposalType on review rows",
      fixedBy: { repo: BE, number: 363 },
    },
    live: {
      kind: "pod",
      sha: SHA(330),
      label: "pod antoinesrvt",
      behindBy: 2,
    },
    prs: [
      pr(BE, 363, {
        title: "Break the import cycle + main typecheck fix",
        checks: "queued",
        redInheritedFromMain: false,
        podSessionId: S_363,
        updatedAt: min(34),
      }),
      pr(BE, 278, { title: "Resolve what needs you (types for browser)" }),
      pr(BE, 337, { title: "Proposal parts reach (types for app)" }),
      ...OTHER_INHERITED.map((n) => pr(BE, n)),
      pr(BE, 351, { draft: true, checks: "none", redInheritedFromMain: false }),
      pr(BE, 274, {
        checks: "green",
        mergeable: "clean",
        redInheritedFromMain: false,
      }),
      pr(BE, 360, {
        title: "negctl: revert the fold",
        branch: "negctl/work-release",
        redInheritedFromMain: false,
      }),
      pr(BE, 361, {
        author: "dependabot[bot]",
        checks: "green",
        redInheritedFromMain: false,
      }),
      pr(BE, 200, {
        redInheritedFromMain: false,
        updatedAt: new Date(NOW - 10 * 24 * 3600_000).toISOString(),
      }),
    ],
    mergedToday: [
      {
        number: 329,
        title: "Pod backup retention ladder",
        url: `https://github.com/${BE}/pull/329`,
        mergedAt: min(120),
      },
      {
        number: 318,
        title: "PR state on work units",
        url: `https://github.com/${BE}/pull/318`,
        mergedAt: min(180),
      },
    ],
    ...over,
  };
}

function browser(over: Partial<RepoSnapshotFact> = {}): RepoSnapshotFact {
  return {
    repo: BR,
    observedAt: min(3),
    visibility: "private",
    main: {
      sha: SHA(2),
      health: "red",
      source: "devbox-baseline",
      reason: "3 test files: ./proposals/fate missing",
      fixedBy: { repo: BE, number: 278 },
    },
    live: null,
    prs: [
      pr(BR, 59, {
        checks: "green",
        mergeable: "clean",
        redInheritedFromMain: false,
      }),
      pr(BR, 60),
    ],
    mergedToday: [],
    ...over,
  };
}

function app(over: Partial<RepoSnapshotFact> = {}): RepoSnapshotFact {
  return {
    repo: APP,
    observedAt: min(4),
    visibility: "private",
    main: {
      sha: SHA(3),
      health: "red",
      source: "devbox-baseline",
      reason: "app-tsc: compositeParts* missing",
      fixedBy: { repo: BE, number: 337 },
    },
    prs: [
      pr(APP, 120, {
        draft: true,
        checks: "none",
        redInheritedFromMain: false,
      }),
      pr(APP, 121),
    ],
    mergedToday: [],
    ...over,
  };
}

const TONIGHT = () => [backend(), browser(), app()];

function prOf(read: WorkReleaseRead, repo: string, number: number) {
  const found = read.prs.find((p) => p.repo === repo && p.number === number);
  if (!found) throw new Error(`no ${repo}#${number} in the read`);
  return found;
}

describe("the snapshot contract (`dev.repo_snapshot`)", () => {
  it("is a dev-loop contract type the door validates", () => {
    expect(REPO_SNAPSHOT_EVENT_TYPE).toBe("dev.repo_snapshot");
    for (const s of TONIGHT()) {
      expect(checkDevLoopPayload(REPO_SNAPSHOT_EVENT_TYPE, s)).toEqual({
        contract: true,
        ok: true,
      });
    }
  });

  it("refuses a PR url of another repo, and a bad health", () => {
    const wrongRepo = backend({
      prs: [pr(BE, 1, { url: `https://github.com/${BR}/pull/1` })],
    });
    const r = checkDevLoopPayload(REPO_SNAPSHOT_EVENT_TYPE, wrongRepo);
    expect(r).toMatchObject({ contract: true, ok: false });
    expect(r.contract && !r.ok && r.error).toContain("prs.0.url");
    const badHealth = {
      ...backend(),
      main: { ...backend().main, health: "x" },
    };
    expect(repoSnapshotEventSchema.safeParse(badHealth).success).toBe(false);
  });
});

describe("stage, verdict, fold — the rows each wrong rule would get wrong", () => {
  it.each([
    // green but not mergeable clean is NOT ready (rules out "green ⇒ ready")
    [{ draft: false, checks: "green", mergeable: "blocked" }, "checks"],
    [{ draft: false, checks: "green", mergeable: "clean" }, "ready"],
    // a draft is working even when green and clean (rules out draft-last)
    [{ draft: true, checks: "green", mergeable: "clean" }, "working"],
    [{ draft: false, checks: "none", mergeable: "clean" }, "working"],
    [{ draft: false, checks: "red", mergeable: "clean" }, "checks"],
    [{ draft: false, checks: "infra", mergeable: "clean" }, "checks"],
  ] as const)("%o → %s", (input, stage) => {
    expect(shipStageOf(input)).toBe(stage);
  });

  it("a red splits by red-vs-main; did-not-run is never a red", () => {
    expect(checkVerdictOf("red", true)).toBe("inherited");
    expect(checkVerdictOf("red", false)).toBe("own_red");
    expect(checkVerdictOf("red", undefined)).toBe("own_red");
    expect(checkVerdictOf("infra", true)).toBe("infra");
    expect(checkVerdictOf("none", undefined)).toBe("unmeasured");
  });

  it("folds: a negative control wins over draft; stale only past 7 days", () => {
    const base = {
      title: "x",
      author: "a",
      draft: false,
      updatedAt: min(10),
    };
    expect(shipFoldOf({ ...base, branch: "negctl/x", draft: true }, NOW)).toBe(
      "negctl"
    );
    expect(shipFoldOf({ ...base, title: "NEGCTL: y" }, NOW)).toBe("negctl");
    expect(shipFoldOf({ ...base, author: "dependabot[bot]" }, NOW)).toBe(
      "dependabot"
    );
    expect(shipFoldOf({ ...base, draft: true }, NOW)).toBe("draft");
    expect(shipFoldOf({ ...base, updatedAt: min(6 * 24 * 60) }, NOW)).toBe(
      null
    );
    expect(shipFoldOf({ ...base, updatedAt: min(8 * 24 * 60) }, NOW)).toBe(
      "stale"
    );
  });
});

describe("foldWorkRelease — tonight", () => {
  const read = foldWorkRelease(TONIGHT(), [], [], { now: NOW });

  it("#363 is the top blocker: 15 PRs and 3 mains wait on it, transitively", () => {
    expect(read.blockers[0]).toEqual({
      ref: { kind: "pr", repo: BE, number: 363 },
      waiting: 18,
      waitingPrs: 15,
      waitingMains: 3,
      reason: "Break the import cycle + main typecheck fix",
    });
  });

  it("then backend main (fixed by #363), then the two types PRs, then the mains", () => {
    expect(
      read.blockers.map((b) => [
        b.ref.kind === "pr" ? `${b.ref.repo}#${b.ref.number}` : b.ref.repo,
        b.waiting,
      ])
    ).toEqual([
      [`${BE}#363`, 18],
      [BE, 17],
      [`${BE}#278`, 2],
      [`${BE}#337`, 2],
      [APP, 1],
      [BR, 1],
    ]);
    const main = read.blockers[1]!;
    expect(main.fixedBy).toEqual({ kind: "pr", repo: BE, number: 363 });
    expect(main.reason).toBe("typecheck: proposalType on review rows");
  });

  it("an inherited red is blocked by its main; an own red is not", () => {
    expect(prOf(read, BE, 278).verdict).toBe("inherited");
    expect(prOf(read, BE, 278).blockedBy).toEqual([{ kind: "main", repo: BE }]);
    expect(prOf(read, BR, 60).blockedBy).toEqual([{ kind: "main", repo: BR }]);
    expect(prOf(read, BE, 200).verdict).toBe("own_red");
    expect(prOf(read, BE, 200).blockedBy).toEqual([]);
    expect(
      read.prs.filter((p) => p.repo === BE && p.verdict === "inherited")
    ).toHaveLength(13);
  });

  it("stages, folds and merged-today", () => {
    expect(prOf(read, BE, 363).stage).toBe("checks");
    expect(prOf(read, BE, 363).verdict).toBe("queued");
    expect(prOf(read, BE, 274).stage).toBe("ready");
    expect(prOf(read, BE, 351)).toMatchObject({
      stage: "working",
      fold: "draft",
    });
    expect(prOf(read, BE, 360).fold).toBe("negctl");
    expect(prOf(read, BE, 361)).toMatchObject({
      fold: "dependabot",
      stage: "checks",
    });
    expect(prOf(read, BE, 200).fold).toBe("stale");
    expect(prOf(read, BE, 329)).toMatchObject({
      stage: "on_main",
      mergedAt: min(120),
    });
  });

  it("repos carry main, live and label; sources are ok", () => {
    expect(read.repos.map((r) => r.label)).toEqual([
      "app-bases",
      "backend",
      "browser",
    ]);
    expect(read.repos[1]!.live?.behindBy).toBe(2);
    expect(read.sources).toEqual({
      snapshots: "ok",
      sessions: "ok",
      holders: "ok",
    });
    expect(read.generatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("blocked-by edges", () => {
  it("drops a dependsOn on a PR merged today or gone from an observed repo; keeps an unobserved one", () => {
    const be = backend({
      prs: [
        pr(BE, 400, {
          redInheritedFromMain: false,
          dependsOn: [
            { repo: BE, number: 329 }, // merged today
            { repo: BE, number: 12 }, // observed repo, not open: merged earlier
            { repo: BE, number: 274 }, // still open
            { repo: "Synap-core/relay-app", number: 57 }, // repo not observed
          ],
        }),
        pr(BE, 274, { checks: "green", redInheritedFromMain: false }),
      ],
    });
    const read = foldWorkRelease([be], [], [], { now: NOW });
    expect(prOf(read, BE, 400).blockedBy).toEqual([
      { kind: "pr", repo: BE, number: 274 },
      { kind: "pr", repo: "Synap-core/relay-app", number: 57 },
    ]);
  });

  it("a main whose fixer merged today waits on nothing (still listed while red)", () => {
    const be = backend({
      prs: [pr(BE, 278)],
      mergedToday: [
        {
          number: 363,
          title: "fix",
          url: `https://github.com/${BE}/pull/363`,
          mergedAt: min(5),
        },
      ],
    });
    const read = foldWorkRelease([be], [], [], { now: NOW });
    expect(read.blockers).toEqual([
      expect.objectContaining({
        ref: { kind: "main", repo: BE },
        waitingPrs: 1,
        fixedBy: { kind: "pr", repo: BE, number: 363 },
      }),
    ]);
  });

  it("a cycle is walked once", () => {
    const be = backend({
      main: { ...backend().main, health: "ok", fixedBy: null },
      prs: [
        pr(BE, 1, {
          redInheritedFromMain: false,
          dependsOn: [{ repo: BE, number: 2 }],
        }),
        pr(BE, 2, {
          redInheritedFromMain: false,
          dependsOn: [{ repo: BE, number: 1 }],
        }),
      ],
      mergedToday: [],
    });
    const read = foldWorkRelease([be], [], [], { now: NOW });
    expect(read.blockers.map((b) => b.waiting)).toEqual([1, 1]);
  });
});

describe("sessions and holders", () => {
  it("an outcome ref beats the body line; several outcomes need the body to choose", () => {
    const be = backend({
      prs: [
        pr(BE, 363, { podSessionId: S_OTHER }),
        pr(BE, 278, { podSessionId: S_278 }),
        pr(BE, 337, { podSessionId: null }),
      ],
    });
    const read = foldWorkRelease(
      [be],
      [
        {
          id: S_363,
          title: "Fix main",
          pullRequests: [{ repo: "synap-core/BACKEND", number: 363 }],
        },
        { id: S_278, title: "Types for browser", pullRequests: [] },
        {
          id: S_OTHER,
          title: "Other",
          pullRequests: [{ repo: BE, number: 337 }],
        },
        {
          id: S_278.replace(/2/g, "4"),
          title: "Twin",
          pullRequests: [{ repo: BE, number: 337 }],
        },
      ],
      [],
      { now: NOW }
    );
    expect(prOf(read, BE, 363)).toMatchObject({
      sessionId: S_363,
      sessionTitle: "Fix main",
    });
    expect(prOf(read, BE, 278)).toMatchObject({
      sessionId: S_278,
      sessionTitle: "Types for browser",
    });
    // two sessions declared #337 and the body names neither: no guess
    expect(prOf(read, BE, 337).sessionId).toBeNull();
  });

  it("holder.live is THE working-now rule: 3 min ago is live, 10 min is not", () => {
    const read = foldWorkRelease(
      [backend()],
      [{ id: S_363, title: "Fix main" }],
      [
        {
          sessionId: S_363,
          label: "Claude Code",
          live: { turnInFlight: false, lastAt: min(3) },
        },
      ],
      { now: NOW }
    );
    expect(prOf(read, BE, 363).holder).toEqual({
      live: true,
      label: "Claude Code",
      lastActiveAt: min(3),
    });
    const later = foldWorkRelease(
      [backend()],
      [{ id: S_363, title: "Fix main" }],
      [
        {
          sessionId: S_363,
          label: "Claude Code",
          live: { turnInFlight: false, lastAt: min(10) },
        },
      ],
      { now: NOW }
    );
    expect(prOf(later, BE, 363).holder?.live).toBe(false);
  });

  it("a FAILED read says unavailable — never an empty list", () => {
    const read = foldWorkRelease(TONIGHT(), null, null, { now: NOW });
    expect(read.sources).toMatchObject({
      sessions: "unavailable",
      holders: "unavailable",
    });
    // the body line still names the session; its title is unknown, not empty
    expect(prOf(read, BE, 363)).toMatchObject({
      sessionId: S_363,
      sessionTitle: null,
      holder: null,
    });
  });
});

describe("snapshots: newest per repo, stale, missing", () => {
  it("the newest snapshot of a repo wins, whatever the spelling", () => {
    const older = backend({ observedAt: min(50), prs: [pr(BE, 1)] });
    const newer = backend({
      repo: "synap-core/backend",
      observedAt: min(1),
      prs: [pr("synap-core/backend", 2)],
    });
    const read = foldWorkRelease([newer, older], [], [], { now: NOW });
    expect(
      read.prs.filter((p) => p.mergedAt === null).map((p) => p.number)
    ).toEqual([2]);
  });

  it("missing with none; stale when even the newest is older than 30 min", () => {
    expect(foldWorkRelease([], [], [], { now: NOW }).sources.snapshots).toBe(
      "missing"
    );
    expect(
      foldWorkRelease([backend({ observedAt: min(31) })], [], [], { now: NOW })
        .sources.snapshots
    ).toBe("stale");
    expect(
      foldWorkRelease(
        [backend({ observedAt: min(31) }), browser({ observedAt: min(29) })],
        [],
        [],
        { now: NOW }
      ).sources.snapshots
    ).toBe("ok");
  });
});

describe("every Ship mark has its word (vocabulary)", () => {
  it.each([
    [SHIP_STAGES, SHIP_STAGE_LABELS],
    [CHECK_VERDICTS, CHECK_VERDICT_LABELS],
    [SHIP_FOLDS, SHIP_FOLD_LABELS],
    [REPO_MAIN_HEALTHS, REPO_MAIN_HEALTH_LABELS],
  ] as const)("%o", (members, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...members].sort());
  });
});
