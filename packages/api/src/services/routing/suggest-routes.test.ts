import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  rankRouteCandidates,
  suggestRoutesForEntities,
  tokenize,
  type RouteCandidate,
} from "./suggest-routes.js";

/**
 * FIXTURE DISCIPLINE: the discriminating input is two candidates for the SAME
 * kind where only one matches the intent text, placed so the textual match is
 * SECOND in the matcher's (updatedAt) order — a ranker that ignores text keeps
 * it second.
 */

const bookmark = { entityId: "e1", profileSlug: "bookmark" };

const candidates: RouteCandidate[] = [
  {
    kind: "playbook",
    id: "pb-archive",
    name: "Archive old links",
    text: ["Move stale bookmarks away"],
    subjectProfileSlug: "bookmark",
  },
  {
    kind: "playbook",
    id: "pb-review",
    name: "Weekly review habit",
    text: ["Read and triage what you saved"],
    subjectProfileSlug: "bookmark",
  },
];

describe("rankRouteCandidates", () => {
  it("with intentText, ranks the textual match FIRST and says why", () => {
    const ranked = rankRouteCandidates({
      entity: bookmark,
      intentText: "I want to review these every week… reviews on Sunday",
      candidates,
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual([
      "pb-review",
      "pb-archive",
    ]);
    expect(ranked[0]!.signals[0]).toEqual({
      type: "intent",
      terms: ["review"],
    });
    expect(ranked[0]!.reason).toMatch(
      /^You mentioned “review” · Made for .+ items$/
    );
    expect(ranked[1]!.reason).toMatch(/^Made for .+ items$/);
  });

  it("breaks an exact tie by NAME, never by the matcher's (updatedAt) order", () => {
    // Both are kind matches with no intent: identical relevance. Input order
    // puts "Weekly…" first (the most recently edited); the name puts
    // "Archive…" first. Reversing the input must not change the answer.
    const reversed = [...candidates].reverse();
    for (const pool of [candidates, reversed]) {
      const ranked = rankRouteCandidates({
        entity: bookmark,
        candidates: pool,
      });
      expect(ranked.map((r) => r.candidate.id)).toEqual([
        "pb-archive",
        "pb-review",
      ]);
    }
  });

  it("a subject-less candidate with no intent match is NOT returned", () => {
    const ranked = rankRouteCandidates({
      entity: { profileSlug: "person", facetSlugs: ["client"] },
      candidates: [
        {
          kind: "automation",
          id: "any",
          name: "Log everything",
          subjectProfileSlug: null,
        },
        {
          kind: "playbook",
          id: "facet",
          name: "Onboard",
          subjectProfileSlug: "client",
        },
        {
          kind: "playbook",
          id: "kind",
          name: "Intro",
          subjectProfileSlug: "person",
        },
      ],
    });
    // "Runs for anything new" is true of it for EVERY request, so it is not
    // evidence: kind and facet come back, the any-kind automation does not.
    expect(ranked.map((r) => r.candidate.id)).toEqual(["kind", "facet"]);
    expect(ranked[1]!.reason).toMatch(/role$/);
  });

  it("anyKind rides along only with a real intent match", () => {
    const ranked = rankRouteCandidates({
      entity: { profileSlug: "person" },
      intentText: "log everything",
      candidates: [
        {
          kind: "automation",
          id: "any",
          name: "Log everything",
          subjectProfileSlug: null,
        },
        {
          kind: "automation",
          id: "any-silent",
          name: "Archive",
          subjectProfileSlug: null,
        },
      ],
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(["any"]);
    expect(ranked[0]!.signals.map((s) => s.type)).toEqual([
      "intent",
      "anyKind",
    ]);
    expect(ranked[0]!.reason).toMatch(/· Runs for anything new$/);
  });
});

describe("rankRouteCandidates — rarity (IDF over the pool)", () => {
  const pb = (id: string, name: string, text: string): RouteCandidate => ({
    kind: "playbook",
    id,
    name,
    text: [text],
    subjectProfileSlug: null,
  });

  it("a word every candidate shares outweighs nothing: the rare word wins", () => {
    // "report" is in 3 of 5, "build" in 1, "weekly" in 2. "common" hits
    // weekly+report, "rare" hits weekly+build: two words each (in their
    // names, so both pass the relevance floor), so under a flat per-word sum
    // they tie and the name tie-break puts "A weekly report" first — that is
    // the defect. Under IDF the one holding the RARE word must win, whatever
    // the input order.
    const pool = [
      pb("common", "A weekly report", "a report that tidies each record"),
      pb("rare", "Weekly build", "each step: build then verify"),
      pb("f1", "Report one", "report notes"),
      pb("f2", "Report two", "report notes"),
      pb("f3", "Other", "nothing to see"),
    ];
    for (const candidates of [pool, [...pool].reverse()]) {
      const ranked = rankRouteCandidates({
        entity: {},
        intentText: "weekly build report",
        candidates,
      });
      expect(ranked[0]!.candidate.id).toBe("rare");
      // f3 matched no word and has no subject: not returned.
      expect(ranked.map((r) => r.candidate.id)).not.toContain("f3");
    }
  });

  it("a one-candidate pool still ranks by words (smoothed IDF never zeroes)", () => {
    const [only] = rankRouteCandidates({
      entity: {},
      intentText: "build",
      candidates: [pb("x", "Build", "")],
    });
    expect(only!.score).toBeGreaterThan(0);
  });
});

/**
 * THE MEASURED CASE, from the live pod (read-only `synap_match_playbooks`,
 * 2026-09-28): the space-brief intent ranked "CRM Hygiene" first on the words
 * "agent" + "each", tied at 6.5 with "AI Dev Session" ("build" + "each") and
 * won on updatedAt. The fixture is the 20-candidate pool that call ranked,
 * with the real goal texts, in the order the pod returned them — so CRM
 * Hygiene PRECEDES AI Dev Session, and an order-keeping tie-break reproduces
 * the defect.
 */
describe("rankRouteCandidates — the live CRM Hygiene case", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./__fixtures__/live-playbook-pool-2026-09-28.json",
        import.meta.url
      ),
      "utf-8"
    )
  ) as {
    candidates: Array<{
      id: string;
      name: string;
      goalTemplate: string;
      subjectProfileSlug: string | null;
    }>;
  };
  // Exactly how `playbooks.matchForEntity` builds its candidates.
  const pool: RouteCandidate[] = fixture.candidates.map((p) => ({
    kind: "playbook",
    id: p.id,
    name: p.name,
    text: [p.goalTemplate],
    subjectProfileSlug: p.subjectProfileSlug,
  }));
  const INTENT =
    "Design and build a feature: space brief so an agent knows what each space is for, then fix MCP discovery gaps";

  it("the fixture is the live pool (non-vacuity)", () => {
    expect(pool).toHaveLength(20);
    const names = pool.map((p) => p.name);
    expect(names.indexOf("CRM Hygiene")).toBeLessThan(
      names.indexOf("AI Dev Session")
    );
  });

  it("never offers CRM Hygiene, nor a candidate whose name says none of the words", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: INTENT,
      candidates: pool,
    });
    const names = ranked.map((r) => r.candidate.name);
    // CRM Hygiene matched only on generic words ("agent", "each"), which are
    // stopwords now, so it is dropped.
    expect(names.indexOf("CRM Hygiene")).toBe(-1);
    // This pool predates descriptions: only goal templates. "AI Dev Session"
    // (once first here, on "build") shares no word with the intent in its
    // NAME, so the relevance floor drops it like every other body-only match.
    expect(names.indexOf("AI Dev Session")).toBe(-1);
    const intentWords = new Set(tokenize(INTENT).keys());
    for (const r of ranked) {
      expect(
        [...tokenize(r.candidate.name).keys()].some((w) => intentWords.has(w))
      ).toBe(true);
    }
  });

  it("returns only candidates that matched a word (no bare 'Runs for anything new')", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: INTENT,
      candidates: pool,
    });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThan(pool.length);
    for (const r of ranked) {
      expect(r.signals.some((s) => s.type === "intent")).toBe(true);
    }
    // Named: these matched no word of the intent on the live call.
    const returned = new Set(ranked.map((r) => r.candidate.name));
    for (const silent of [
      "Dogfood sweep",
      "Security Audit",
      "Market Research Sprint",
    ]) {
      expect(returned.has(silent)).toBe(false);
    }
  });
});

describe("suggestRoutesForEntities", () => {
  it("merges playbooks and automations per entity, drops signal-less candidates, caps the list", () => {
    const [s] = suggestRoutesForEntities({
      intentText: "weekly review",
      entities: [
        {
          ...bookmark,
          candidates: [
            ...candidates,
            {
              kind: "automation",
              id: "au-other",
              name: "Other",
              subjectProfileSlug: "task",
            },
          ],
        },
      ],
      limit: 1,
    });
    expect(s!.entityId).toBe("e1");
    expect(s!.suggestions.map((r) => r.candidate.id)).toEqual(["pb-review"]);
  });
});

describe("rankRouteCandidates — generic words are not evidence (matcher-fixes)", () => {
  const generic: RouteCandidate[] = [
    {
      kind: "playbook",
      id: "generic",
      name: "Night shift",
      text: [
        "Every work session needs one agent per goal: ask the right owner, per task",
      ],
      subjectProfileSlug: null,
    },
    {
      kind: "playbook",
      id: "tokens",
      name: "Cut token spend",
      text: ["Fewer tokens per unit of work"],
      subjectProfileSlug: null,
    },
  ];
  const goal =
    "The founder's agents spend fewer tokens per unit of work: one ask routes to the right playbook, every work session binds to one playbook, and needs a goal";

  it("never offers a stopword as a matched term or in the reason, and drops a candidate that only shares them", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: goal,
      candidates: generic,
    });
    // the generic-only candidate is dropped (no anyKind-only rescue either)
    expect(ranked.map((r) => r.candidate.id)).toEqual(["tokens"]);
    const terms = ranked.flatMap((r) =>
      r.signals.flatMap((s) => (s.type === "intent" ? s.terms : []))
    );
    expect(terms).toContain("tokens");
    for (const w of [
      "per",
      "one",
      "every",
      "work",
      "needs",
      "ask",
      "right",
      "session",
      "binds",
      "agents",
      "goal",
    ]) {
      expect(terms).not.toContain(w);
      expect(ranked[0]!.reason).not.toContain(`“${w}”`);
    }
  });

  it("keeps domain words that look generic but are evidence (fix, synap, backend)", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: "fix a bug in synap-backend and land it",
      candidates: [
        {
          kind: "playbook",
          id: "ship",
          name: "Ship a fix",
          text: ["fix the backend"],
          subjectProfileSlug: null,
        },
      ],
    });
    expect(ranked[0]!.signals[0]).toEqual({
      type: "intent",
      terms: ["fix", "backend"],
    });
  });
});

describe("tokenize — contractions never yield fragment tokens", () => {
  it('"You don\'t own your digital life" carries no "don" and no "own"', () => {
    expect([...tokenize("You don't own your digital life").keys()]).toEqual([
      "digital",
      "life",
    ]);
  });

  it.each([
    "can't",
    "won\u2019t",
    "it's",
    "you're",
    "we've",
    "they'll",
    "I'd",
    "I'm",
    "doesn't",
  ])("%s yields no token", (word) => {
    expect([...tokenize(`${word} carousel`).keys()]).toEqual(["carousel"]);
  });

  it("a possessive keeps its stem; a French elision still splits", () => {
    expect([...tokenize("Alice's report").keys()]).toEqual(["alice", "report"]);
    expect([...tokenize("l'agent d'accord").keys()]).toEqual([
      "agent",
      "accord",
    ]);
  });
});

describe("tokenize — the pod-wide stop list is unchanged; generic work words are the ranker's own", () => {
  it("'Agents need goals per session' tokenizes exactly as on main (recall, dedup, find)", () => {
    expect([...tokenize("Agents need goals per session").keys()]).toEqual([
      "agent",
      "need",
      "goal",
      "per",
      "session",
    ]);
  });

  it("the playbook ranker drops those words: intent made only of them matches nothing", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: "Agents need goals per session",
      candidates: [
        {
          kind: "playbook",
          id: "p",
          name: "Agent session goals",
          text: ["each session needs a goal per agent"],
          subjectProfileSlug: null,
        },
      ],
    });
    expect(ranked).toEqual([]);
  });
});

/**
 * THE NAME IS THE EVIDENCE (tickets b2ba4b6b, 84d2add0, 9753144a). Each pool
 * keeps the live playbook's name and description (2026-11-17) and a short
 * body standing in for its long goal template, with the words the live
 * reply named as the match. The intents are the tickets' own words.
 */
describe("rankRouteCandidates — the name is the evidence, a relevance floor", () => {
  const pb = (
    id: string,
    name: string,
    description: string,
    body: string[] = []
  ): RouteCandidate => ({
    kind: "playbook",
    id,
    name,
    description,
    text: [description, ...body],
    subjectProfileSlug: null,
  });

  it("84d2add0: the playbook NAMED 'Newsletter issue' outranks one whose description mentions it", () => {
    const pool = [
      pb(
        "derive",
        "Derive outputs",
        "Make posts from a piece, spread over two weeks on the accounts you pick (several per account, never two on one account the same day), each linked to the piece, and optionally a newsletter issue.",
        ["Write the posts for the week"]
      ),
      pb(
        "letter",
        "Newsletter issue",
        "Take a newsletter issue from idea to sent — angle, draft, edit, schedule — with a person approving before it goes out.",
        ["Send the issue once approved", "Idea", "Drafting", "Sent"]
      ),
      pb(
        "update",
        "Write the weekly client update",
        "Every Monday, draft each active client's update from what happened in the pod (done, next, decisions needed, risks, budget used) for a person to edit and send.",
        ["Draft the updates", "Person edits and sends"]
      ),
      pb("bill", "Bill a client", "Issue an invoice for delivered work and send it."),
      pb("plan", "Plan Next Content", "Decide what to publish next."),
    ];
    for (const candidates of [pool, [...pool].reverse()]) {
      const ranked = rankRouteCandidates({
        entity: {},
        intentText: "write and send this week's newsletter issue",
        candidates,
      });
      const ids = ranked.map((r) => r.candidate.id);
      expect(ids[0]).toBe("letter");
      expect(ids.indexOf("derive")).toBeGreaterThan(0);
      // "send" and "issue" sit only in Bill a client's description (2 of the
      // request's 5 words), never in its name: not offered.
      expect(ids).not.toContain("bill");
    }
  });

  it("9753144a: a restore drill is offered nothing on 'prove, backend, pod, new, apply' found in a long body", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      // matchSessionTemplate's intent: title + goal.
      intentText:
        "Promise Keeper 2026-11-17 · Tue P3 ownership drill Prove on current backend main that a pod's Postgres migrates from zero, dumps and restores losslessly, and that this week's new migrations apply cleanly.",
      candidates: [
        pb(
          "website",
          "Build a website (Website Factory)",
          "Create a NEW website from the Website Factory template, with the pod's published data.",
          [
            "Prove the build on a preview before production; the backend stays the pod's own; apply the plan the person approved.",
          ]
        ),
        pb("letter", "Newsletter issue", "Take a newsletter issue from idea to sent.", [
          "Write the issue this week",
        ]),
        pb("content", "Produce Content", "Take a briefed post from brief to published.", [
          "Publish what is new on the pod's channels",
        ]),
      ],
    });
    expect(ranked).toEqual([]);
  });

  it("b2ba4b6b: an orientation spec is not offered 'Produce Content' on route, spec, first, read, records, identity", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText:
        "Agent orientation route: spec and first fixes An outside agent can learn what Synap is, who it is for, where it stands and what is stale in one compact read, with Foundation records answering identity questions first.",
      candidates: [
        pb(
          "content",
          "Produce Content",
          "Take a briefed post from brief to published, from the Synap brand kit.",
          [
            "Route each draft to the spec first; read where the piece stands; the records of the brand identity come first.",
          ]
        ),
        pb("website", "Website Factory", "Create a new website.", ["Read the spec"]),
      ],
    });
    expect(ranked).toEqual([]);
  });

  it("a description that holds most of the request still admits a candidate whose name does not", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: "make a reel from my take",
      candidates: [
        pb(
          "take",
          "Enhance a recording",
          "Turn a recorded take into a vertical reel: cut, caption and export the best pieces.",
          ["Run the passes on {take}"]
        ),
      ],
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(["take"]);
  });

  it("a structural signal is evidence about the entity: the floor never cuts it", () => {
    const ranked = rankRouteCandidates({
      entity: { profileSlug: "post" },
      intentText: "publish this tomorrow morning",
      candidates: [
        {
          kind: "playbook",
          id: "kind",
          name: "Produce content",
          text: ["Publish the post on its channels"],
          subjectProfileSlug: "post",
        },
      ],
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(["kind"]);
    expect(ranked[0]!.signals.map((s) => s.type)).toEqual(["intent", "kind"]);
  });
});
