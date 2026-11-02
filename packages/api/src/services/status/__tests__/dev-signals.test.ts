/**
 * THE DEV SIGNAL RULES (`dev-signals.ts`), pure, over one repo's snapshot: a
 * ready PR left green and unmerged, a ready PR left red with no push (its own
 * red only), a red main nobody owns — each on the session that owns it, at
 * the work clock's rungs, raised in-app first and escalated once.
 */
import { describe, expect, it } from "vitest";
import type { RepoSnapshotFact } from "@synap-core/types";
import { WORK_CLOCK } from "@synap-core/types/work-clock";
import {
  capWords,
  culpritsToLookUp,
  DEV_SIGNAL_RUNGS,
  devSignalsOf,
  mainRedRepoOf,
  ownsMainRed,
  repoStuckFolds,
  REASON_MAX,
  type CulpritFact,
  type MainRedOwner,
} from "../dev-signals.js";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const HOUR = 3_600_000;

type Pr = RepoSnapshotFact["prs"][number];
const pr = (number: number, over: Partial<Pr>): Pr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/Synap-core/backend/pull/${number}`,
  headSha: "a".repeat(39) + String(number % 10),
  draft: false,
  author: "agent",
  updatedAt: ago(WORK_CLOCK.stale + HOUR),
  mergeable: "clean",
  checks: "green",
  podSessionId: S1,
  autoMerge: false,
  ...over,
});

const snapshot = (
  over: Partial<RepoSnapshotFact> = {},
  main: Partial<RepoSnapshotFact["main"]> = {}
): RepoSnapshotFact => ({
  repo: "Synap-core/backend",
  observedAt: NOW.toISOString(),
  visibility: "public",
  main: { sha: "b".repeat(40), health: "ok", source: "github-checks", ...main },
  prs: [],
  mergedToday: [],
  ...over,
});

const signals = (
  s: RepoSnapshotFact,
  owners: MainRedOwner[] = [],
  culprits?: ReadonlyMap<number, CulpritFact>
) => devSignalsOf(s, { now: NOW, owners, culprits });

describe("the dev signal rules", () => {
  it("every N is a rung of the work clock", () => {
    expect(DEV_SIGNAL_RUNGS).toEqual({
      pr_green_unmerged: { first: "stale", escalate: "stuck" },
      pr_red_idle: { first: "stale", escalate: "stuck" },
      main_red_unowned: { first: "quiet", escalate: "stale" },
    });
  });

  it("a ready PR green and unchanged for a day is raised on its session, in-app first", () => {
    const [s, ...rest] = signals(snapshot({ prs: [pr(539, {})] }));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      signal: "pr_green_unmerged",
      sessionId: S1,
      escalated: false,
      episodeKey: `synap-core/backend#539@${"a".repeat(39)}9`,
      beganAt: ago(HOUR),
      facts: {
        repo: "synap-core/backend",
        label: "backend#539",
        number: 539,
        url: "https://github.com/Synap-core/backend/pull/539",
      },
    });
  });

  it("a PR red with no push for a day is raised; a red it inherits from main is not its own", () => {
    const out = signals(
      snapshot({
        prs: [
          pr(540, { checks: "red", podSessionId: S2 }),
          pr(541, { checks: "red", redInheritedFromMain: true }),
        ],
      })
    );
    expect(out.map((s) => [s.signal, s.sessionId, s.facts.number])).toEqual([
      ["pr_red_idle", S2, 540],
    ]);
  });

  it("raises nothing for a young PR, a draft, a PR no session owns, or checks that say nothing", () => {
    const out = signals(
      snapshot({
        prs: [
          pr(1, { updatedAt: ago(WORK_CLOCK.stale - HOUR) }),
          pr(2, { draft: true }),
          pr(3, { podSessionId: null }),
          pr(4, { checks: "running" }),
          pr(5, { checks: "infra" }),
          pr(6, { checks: "queued" }),
          pr(7, { updatedAt: "not a date" }),
        ],
      })
    );
    expect(out).toEqual([]);
  });

  it("escalates once: past the escalate rung only the escalation is raised, a new episode key", () => {
    const [s] = signals(
      snapshot({ prs: [pr(539, { updatedAt: ago(WORK_CLOCK.stuck + HOUR) })] })
    );
    expect(s).toMatchObject({
      signal: "pr_green_unmerged",
      escalated: true,
      episodeKey: `synap-core/backend#539@${"a".repeat(39)}9:escalated`,
      beganAt: ago(HOUR),
    });
  });

  it("a push is a new episode: the key follows the head sha", () => {
    const [a] = signals(
      snapshot({ prs: [pr(539, { headSha: "c".repeat(40) })] })
    );
    const [b] = signals(
      snapshot({ prs: [pr(539, { headSha: "d".repeat(40) })] })
    );
    expect(a!.episodeKey).not.toBe(b!.episodeKey);
  });

  it("a red main nobody owns is told to the session of the PR that turned it red", () => {
    const red = {
      health: "red" as const,
      redSince: {
        sha: "e".repeat(40),
        prNumber: 530,
        at: ago(WORK_CLOCK.quiet + HOUR),
      },
      reason: "typecheck: proposalType",
    };
    const merged = [
      {
        number: 530,
        title: "feat",
        url: "https://github.com/Synap-core/backend/pull/530",
        mergedAt: ago(2 * HOUR),
        podSessionId: S2,
      },
    ];
    const [s, ...rest] = signals(snapshot({ mergedToday: merged }, red));
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      signal: "main_red_unowned",
      sessionId: S2,
      escalated: false,
      episodeKey: `synap-core/backend@${"e".repeat(40)}`,
      facts: {
        label: "backend main",
        culpritLabel: "backend#530",
        reason: "typecheck: proposalType",
      },
    });
    // Owned: an active `main red: backend …` session started since the red
    // began (CI's rule), or a fix PR named.
    expect(
      signals(snapshot({ mergedToday: merged }, red), [
        { title: "main red: backend tsc @eeee", startedAt: ago(HOUR) },
      ])
    ).toEqual([]);
    // An older owner session was about an EARLIER red: it owns nothing now.
    expect(
      signals(snapshot({ mergedToday: merged }, red), [
        {
          title: "main red: backend tsc @0000",
          startedAt: ago(WORK_CLOCK.quiet + 2 * HOUR),
        },
      ]).map((x) => x.signal)
    ).toEqual(["main_red_unowned"]);
    expect(
      signals(
        snapshot(
          { mergedToday: merged },
          { ...red, fixedBy: { repo: "Synap-core/backend", number: 570 } }
        )
      )
    ).toEqual([]);
    // Young, or not measured: nothing.
    expect(
      signals(
        snapshot(
          { mergedToday: merged },
          {
            ...red,
            redSince: { ...red.redSince, at: ago(WORK_CLOCK.quiet - 60_000) },
          }
        )
      )
    ).toEqual([]);
    expect(
      signals(
        snapshot(
          { mergedToday: merged },
          {
            ...red,
            redSince: { sha: red.redSince.sha },
          }
        )
      )
    ).toEqual([]);
    // infra is not red.
    expect(
      signals(snapshot({ mergedToday: merged }, { ...red, health: "infra" }))
    ).toEqual([]);
  });

  it("a red main whose culprit names no session is raised with no session (counted, never guessed)", () => {
    const [s] = signals(
      snapshot(
        {},
        {
          health: "red",
          redSince: { sha: "e".repeat(40), at: ago(WORK_CLOCK.stale + HOUR) },
        }
      )
    );
    expect(s).toMatchObject({
      signal: "main_red_unowned",
      sessionId: null,
      escalated: true,
      facts: { culpritLabel: null },
    });
  });

  it("reads the repo an open `main red:` session owns off its title", () => {
    expect(
      [
        "main red: backend Full suite @1234abcd",
        "Main red: App-Bases tsc",
        "fix main red later",
        null,
      ].map(mainRedRepoOf)
    ).toEqual(["backend", "app-bases", null, null]);
    const at = ago(HOUR);
    expect(
      ownsMainRed(
        [{ title: "main red: backend x", startedAt: at }],
        "synap-core/backend",
        at
      )
    ).toBe(true);
    expect(
      ownsMainRed(
        [{ title: "main red: browser x", startedAt: at }],
        "synap-core/backend",
        at
      )
    ).toBe(false);
    expect(
      ownsMainRed(
        [{ title: "main red: backend x", startedAt: null }],
        "synap-core/backend",
        at
      )
    ).toBe(false);
  });

  it("a culprit merged before today is found through its dev.pr_merged fact", () => {
    const red = {
      health: "red" as const,
      redSince: {
        sha: "e".repeat(40),
        prNumber: 400,
        at: ago(WORK_CLOCK.quiet + HOUR),
      },
    };
    const s = snapshot({}, red);
    expect(culpritsToLookUp(s)).toBe(400);
    const [x] = signals(
      s,
      [],
      new Map([[400, { sessionId: S2, title: "feat: the old one" }]])
    );
    expect(x).toMatchObject({
      signal: "main_red_unowned",
      sessionId: S2,
      facts: { culpritLabel: "backend#400", culpritTitle: "feat: the old one" },
    });
    // Named by mergedToday: nothing to look up.
    expect(
      culpritsToLookUp(
        snapshot(
          {
            mergedToday: [
              {
                number: 400,
                title: "x",
                url: "https://github.com/Synap-core/backend/pull/400",
                mergedAt: ago(HOUR),
                podSessionId: S1,
              },
            ],
          },
          red
        )
      )
    ).toBeNull();
    expect(culpritsToLookUp(snapshot())).toBeNull();
  });

  it("is quiet about green PRs while main is red (the queue holds them); a PR's own red still raises", () => {
    const out = signals(
      snapshot(
        {
          prs: [pr(539, {}), pr(540, { checks: "red", podSessionId: S2 })],
        },
        {
          health: "red",
          redSince: { sha: "e".repeat(40), at: ago(WORK_CLOCK.quiet - HOUR) },
        }
      )
    );
    expect(out.map((x) => [x.signal, x.facts.number])).toEqual([
      ["pr_red_idle", 540],
    ]);
  });

  it("caps the words a signal carries: a PR title, what is red on main", () => {
    const long = "x".repeat(REASON_MAX + 50);
    const [x] = signals(
      snapshot(
        {},
        {
          health: "red",
          redSince: { sha: "e".repeat(40), at: ago(WORK_CLOCK.quiet + HOUR) },
          reason: long,
        }
      )
    );
    expect(x!.facts.reason).toHaveLength(REASON_MAX);
    expect(x!.facts.reason!.endsWith("…")).toBe(true);
    expect(capWords("  a\n  b  ", 10)).toBe("a b");
    expect(capWords("   ", 10)).toBeNull();
  });

  it("D-R2: three or more PRs of one repo escalated at once fold into one", () => {
    const old = { updatedAt: ago(WORK_CLOCK.stuck + HOUR) };
    const out = signals(
      snapshot({
        prs: [
          pr(12, old),
          pr(10, { ...old, checks: "red" }),
          pr(11, old),
          // Not escalated yet: the agent's alone (D-R3), never counted.
          pr(13, {}),
        ],
      })
    );
    const folds = repoStuckFolds(out);
    expect([...folds]).toEqual([
      [
        "synap-core/backend",
        { count: 3, labels: ["backend#10", "backend#11", "backend#12"] },
      ],
    ]);
    expect(repoStuckFolds(out.slice(0, 2)).size).toBe(0);
  });
});
