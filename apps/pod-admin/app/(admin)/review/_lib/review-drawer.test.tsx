/**
 * The proposal review, RENDERED in both of its hosts — the console's Review
 * dock and the `/proposal/[id]` receiver page (react-dom/server; pod-admin's
 * vitest runs in node). Asserts what the reader SEES.
 *
 * The defect this pins (founder, 2026-10-23): the drawer drew its own "who /
 * when / where" rows AND embedded the decision, which drew a second
 * provenance box ("Where this came from") and a second "Advanced · raw
 * request" — provenance three times and Advanced twice in one panel. One
 * owner now draws each, once; both hosts must show exactly one of each.
 *
 * The fixture is the wire shape `proposals.get` returns for a kind change
 * (`review.changes` from `routers/proposals/changes.ts`), with invented names.
 *
 * And what its SESSION is for (founder, 2026-10-26: the purpose sat behind a
 * click): goal, criteria, track, project and what else waits, in both hosts —
 * each read's empty, not-yours and failed states apart — and, on the page,
 * the door to the next waiting proposal once this one is decided.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

/* Hoisted: `vi.mock` factories run before this file's own declarations. */
const {
  PROPOSAL_ID,
  SESSION_ID,
  TRACK_ID,
  PROJECT_ID,
  NEXT_ID,
  NAME,
  PROPOSAL,
  TARGETS,
  state,
  reads,
  query,
} = vi.hoisted(() => {
  const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
  const SESSION_ID = "22222222-2222-4222-8222-222222222222";
  const AGENT_ID = "33333333-3333-4333-8333-333333333333";
  const TARGET_ID = "44444444-4444-4444-8444-444444444444";
  const NAME = "Gap: search tools bypass the capability gate";

  const PROPOSAL = {
    id: PROPOSAL_ID,
    workspaceId: null,
    targetType: "entity",
    targetId: TARGET_ID,
    targetName: NAME,
    proposalType: "update",
    status: "pending",
    agentUserId: AGENT_ID,
    governanceReason: "SCOPE_IDENTITY_CHANGE",
    createdAt: new Date(Date.now() - 26 * 3_600_000),
    authorName: "Claude-code",
    agentActorName: "Claude-code",
    principal: { kind: "delegated", name: "Ada Lovelace" },
    revertable: false,
    data: {},
    request: {
      targetType: "entity",
      targetId: TARGET_ID,
      changeType: "update",
      targetName: NAME,
      data: { id: TARGET_ID, profileSlug: "issue" },
      reasoning: "Product problems move from finding to issue.",
    },
    review: {
      reasoning: "Product problems move from finding to issue.",
      changes: [
        {
          path: "profileSlug",
          label: "ProfileSlug",
          operation: "update",
          before: "finding",
          after: "issue",
          valueType: "string",
          drift: "unchanged",
        },
      ],
    },
  };

  const TARGETS = [
    { kind: "agent", id: AGENT_ID, label: "Claude-code" },
    { kind: "session", id: SESSION_ID, label: "Build wave 2" },
  ];
  const TRACK_ID = "55555555-5555-4555-8555-555555555555";
  const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
  const NEXT_ID = "77777777-7777-4777-8777-777777777777";

  /** A tRPC query result: data, a failure (by code), or in flight. */
  type Q = { data?: unknown; error?: unknown; isLoading?: boolean };
  const ok = (data: unknown): Q => ({ data });
  const fail = (code: string): Q => ({ error: { data: { code } } });
  const cluster = (proposalId: string, title: string) => ({
    id: `proposal-cluster:${proposalId}`,
    kind: "proposal-cluster",
    title,
    count: 1,
    groupKey: null,
    ageBucket: "today",
    repeatCount: 1,
    target: { kind: "proposal", id: proposalId },
    proposalIds: [proposalId],
  });
  const SESSION = {
    id: SESSION_ID,
    title: "Build wave 2",
    goal: "Every search tool goes through the capability gate.",
    trackId: TRACK_ID,
    continuation: {
      evaluation: {
        status: "ok",
        verdict: { passed: 2, total: 3, state: "incomplete" },
      },
      project: {
        status: "ok",
        project: { id: PROJECT_ID, name: "Synap" },
      },
    },
  };
  /** An agent's question on a session slot (`owed-slot`). */
  const ask = (id: string) => ({
    id: `owed:${id}`,
    kind: "owed-slot",
    title: "Which tone for the launch post?",
    count: 1,
    groupKey: null,
    ageBucket: "today",
    repeatCount: 1,
    target: { kind: "session", id: SESSION_ID },
  });
  const state = {
    status: "pending",
    /** Review's query string (`?session=` narrows it). */
    search: "",
    /** Fields laid over the fixture proposal (a different review). */
    proposal: {} as Record<string, unknown>,
    /** `proposals.approvalProgress` — a background apply, when one runs. */
    progress: null as unknown,
    session: ok(SESSION) as Q,
    track: ok({ id: TRACK_ID, name: "Hardening" }) as Q,
    /** `signals.list` scoped to the session. */
    waiting: ok({
      signals: [cluster(PROPOSAL_ID, NAME), cluster(NEXT_ID, "Create Linus")],
    }) as Q,
    /** `signals.list` pod-wide — Review's own read. */
    queue: ok({ signals: [cluster(NEXT_ID, "Create Linus")] }) as Q,
  };
  const reads = { ok, fail, cluster, ask, SESSION };
  /** A query hook answering from `state` (disabled ⇒ no data, not loading). */
  const query =
    (
      pick: (input: Record<string, unknown>) => {
        data?: unknown;
        error?: unknown;
        isLoading?: boolean;
      }
    ) =>
    (input: Record<string, unknown>, opts?: { enabled?: boolean }) => {
      const r = opts?.enabled === false ? {} : pick(input);
      return {
        data: r.data,
        error: r.error ?? null,
        isLoading: r.isLoading ?? false,
        refetch() {},
      };
    };
  return {
    PROPOSAL_ID,
    SESSION_ID,
    TRACK_ID,
    PROJECT_ID,
    NEXT_ID,
    NAME,
    PROPOSAL,
    TARGETS,
    state,
    reads,
    query,
  };
});

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    proposals: {
      get: {
        useQuery: () => ({
          data: { ...PROPOSAL, status: state.status, ...state.proposal },
          isLoading: false,
          error: null,
          refetch() {},
        }),
      },
      source: { useQuery: () => ({ data: { targets: TARGETS } }) },
      approvalProgress: {
        useQuery: () => ({
          data: state.progress,
          isError: false,
          isFetching: false,
          refetch() {},
        }),
      },
      approve: { useMutation: () => ({ mutate() {}, isPending: false }) },
      reject: { useMutation: () => ({ mutate() {}, isPending: false }) },
      // The failed-approval card (`FailedApproval.tsx`): nothing to fix here.
      repairOptions: {
        useQuery: () => ({
          data: { proposalId: "p", repairable: false, fields: [] },
          isLoading: false,
          isError: false,
          refetch() {},
        }),
      },
      repair: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
    workspaces: { get: { useQuery: () => ({ data: undefined }) } },
    focusSessions: { get: { useQuery: query(() => state.session) } },
    tracks: { get: { useQuery: query(() => state.track) } },
    signals: {
      list: {
        useQuery: query((input) =>
          input.sessionId ? state.waiting : state.queue
        ),
      },
    },
    // The record card's definition reads (`use-record-definitions.ts`).
    useQueries: () => [],
    profiles: { get: { useQuery: () => ({ data: undefined }) } },
    entities: { get: { useQuery: () => ({ data: undefined }) } },
    governanceRules: {
      create: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
  },
}));

import { ReviewDock } from "./review-drawer";
import { ProposalReview } from "../../../proposal/[id]/ProposalReview";
import { ProposalReviewBody } from "../../../proposal/[id]/ProposalReviewCard";

/** Visible text only — attributes and tags stripped. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const count = (haystack: string, needle: RegExp) =>
  (haystack.match(new RegExp(needle, "g")) ?? []).length;

const dock = () =>
  renderToStaticMarkup(
    <ReviewDock
      open={{
        detail: { kind: "proposal", proposalId: PROPOSAL_ID },
        title: `Update "${NAME}"`,
      }}
      viewer={{ identity: "Ada Lovelace", podHost: "pod.example.test" }}
      onClose={() => {}}
      liveAsk={null}
      onAskSettled={() => {}}
    />
  );

const page = () =>
  renderToStaticMarkup(
    <ProposalReview
      proposalId={PROPOSAL_ID}
      podHost="pod.example.test"
      identity="Ada Lovelace"
    />
  );

describe.each([
  ["the Review dock", dock],
  ["the /proposal page", page],
])("%s — one of each", (_host, render) => {
  it("exactly ONE Advanced, and no second raw-request disclosure", () => {
    const seen = text(render());
    expect(count(seen, /\bAdvanced\b/)).toBe(1);
    expect(seen).not.toMatch(/raw request/i);
  });

  it("exactly ONE provenance line, and none of the old copies", () => {
    const html = render();
    expect(count(html, /data-review-provenance/)).toBe(1);
    const seen = text(html);
    expect(seen).not.toMatch(/Where this came from/i);
    expect(seen).not.toMatch(/When and from where/i);
    expect(seen).not.toMatch(/Requested by/);
  });

  it("the provenance names the agent, the person, the session (a door) and when", () => {
    const html = render();
    const line = html.slice(html.indexOf("data-review-provenance"));
    expect(text(line)).toMatch(
      /Claude-code for AL Ada Lovelace Build wave 2 1d ago/
    );
    expect(line).toContain(`href="/open/session/${SESSION_ID}"`);
    // The absolute date rides on the relative one, for hover.
    expect(line).toMatch(/<time dateTime="[^"]+" title="[^"]+">1d ago<\/time>/);
  });

  it("the change comes first, in words: Kind Finding → Issue", () => {
    const seen = text(render());
    expect(seen).toMatch(/Kind Finding Issue/);
    expect(seen).not.toMatch(/ProfileSlug/);
    expect(seen.indexOf("Finding")).toBeLessThan(
      seen.indexOf("Changes what it is")
    );
  });

  it("why: the reason as ONE mark (its sentence behind it), the proposer's words as theirs", () => {
    const html = render();
    const seen = text(html);
    expect(html).toContain('data-review-mark="Changes what it is"');
    // The sentence is read from its one home, so a rewording never reds this.
    expect(seen).not.toContain(
      GOVERNANCE_POLICY_SENTENCES.SCOPE_IDENTITY_CHANGE
    );
    expect(seen).toContain(
      "Note from Claude-code Product problems move from finding to issue."
    );
  });

  it("the decision bar: the verbs, what approving does, who decides", () => {
    const html = render();
    expect(count(html, /data-review-decision/)).toBe(1);
    const seen = text(html);
    expect(seen).toMatch(/Can't be undone/);
    expect(seen).toMatch(/Approve .*Reject…/);
    expect(seen).toMatch(
      /You decide as Ada Lovelace · recorded in the Audit log/
    );
    // Advanced is the last thing, under the bar.
    expect(seen.indexOf("Advanced")).toBeGreaterThan(seen.indexOf("Reject…"));
    expect(seen.indexOf("Advanced")).toBeGreaterThan(
      seen.indexOf("recorded in the Audit log")
    );
  });
});

/** The session strip alone (from its marker to the next section). */
const sessionStrip = (html: string) => {
  const at = html.indexOf("data-review-session");
  return at < 0 ? null : html.slice(at, html.indexOf("data-review-decision"));
};

/** Reset `state` to the founder's case before each test. */
const DEFAULTS = { ...state };
const reset = () => Object.assign(state, DEFAULTS);

describe.each([
  ["the Review dock", dock],
  ["the /proposal page", page],
])("%s — what the session is for", (_host, render) => {
  it("goal, criteria progress, track and project (doors), what else waits", () => {
    reset();
    const strip = sessionStrip(render());
    expect(strip).not.toBeNull();
    expect(text(strip!)).toMatch(
      /Every search tool goes through the capability gate\. 2 of 3 criteria met Hardening Synap 1 more waiting/
    );
    // The criteria mark is a door to the session, named by the verdict's word.
    expect(strip).toMatch(
      new RegExp(
        `href="/open/session/${SESSION_ID}"[^>]*title="Partly checked"`
      )
    );
    // A goal is hosted on the web (`/open/track/:id`), so its door stays here.
    expect(strip).toContain(`href="/open/track/${TRACK_ID}"`);
    expect(strip).toContain(`href="synap://open/project/${PROJECT_ID}"`);
    expect(strip).toContain(`href="/review?session=${SESSION_ID}"`);
  });

  it("sits right under the provenance line, before the change", () => {
    reset();
    const html = render();
    const at = html.indexOf("data-review-session");
    expect(at).toBeGreaterThan(html.indexOf("data-review-provenance"));
    expect(text(html.slice(at))).toMatch(/Kind Finding Issue/);
  });

  it("a session the reader may not read draws nothing", () => {
    reset();
    state.session = reads.fail("NOT_FOUND");
    const html = render();
    expect(sessionStrip(html)).toBeNull();
    // …and no failure either: "not yours" is not "could not be read".
    expect(text(html)).not.toMatch(/couldn’t be read/);
  });

  it("a FAILED session read says so, with a retry — never vanishes", () => {
    reset();
    state.session = reads.fail("INTERNAL_SERVER_ERROR");
    const seen = text(render());
    expect(seen).toMatch(/This session couldn’t be read\. Retry/);
  });

  it("an expired sign-in is not drawn as a failure (the reader is sent to sign in)", () => {
    reset();
    state.session = reads.fail("UNAUTHORIZED");
    expect(text(render())).not.toMatch(/couldn’t be read/);
  });

  it("no criteria, no project, no track, nothing else waiting: only the goal", () => {
    reset();
    state.session = reads.ok({
      ...reads.SESSION,
      trackId: null,
      continuation: {
        evaluation: {
          status: "ok",
          verdict: { passed: 0, total: 0, state: "none" },
        },
        project: { status: "ok", project: null },
      },
    });
    state.waiting = reads.ok({ signals: [reads.cluster(PROPOSAL_ID, NAME)] });
    const strip = text(sessionStrip(render())!);
    expect(strip).toMatch(
      /Every search tool goes through the capability gate\./
    );
    expect(strip).not.toMatch(/criteri|Hardening|Synap|more waiting/);
  });

  it("failed criteria, track and count reads: said ONCE, with ONE retry", () => {
    reset();
    state.session = reads.ok({
      ...reads.SESSION,
      continuation: {
        ...reads.SESSION.continuation,
        evaluation: { status: "unavailable" },
      },
    });
    state.track = reads.fail("INTERNAL_SERVER_ERROR");
    state.waiting = reads.fail("INTERNAL_SERVER_ERROR");
    const strip = text(sessionStrip(render())!);
    expect(strip).toMatch(/Part of this session couldn’t be read\. Retry/);
    expect(count(strip, /couldn’t be read/)).toBe(1);
    expect(count(strip, /\bRetry\b/)).toBe(1);
  });
});

describe("the Review dock narrowed to this session", () => {
  it("drops the 'more waiting' door: it would reload the page the reader is on", () => {
    reset();
    state.search = `session=${SESSION_ID}`;
    const strip = sessionStrip(dock())!;
    expect(text(strip)).toMatch(/2 of 3 criteria met/);
    expect(text(strip)).not.toMatch(/more waiting/);
    expect(strip).not.toContain("/review?session=");
  });
});

describe("the /proposal page — the next waiting proposal", () => {
  it("while it is still to decide: no next door", () => {
    reset();
    expect(page()).not.toContain("data-review-next");
  });

  it("decided: a door to the first proposal Review lists", () => {
    reset();
    state.status = "approved";
    const html = page();
    expect(html).toContain(`data-review-next="${NEXT_ID}"`);
    expect(html).toContain(`href="/proposal/${NEXT_ID}"`);
    expect(text(html)).toMatch(/Next: Create Linus/);
  });

  it("nothing else at all: said calmly, in Review's own words", () => {
    reset();
    state.status = "rejected";
    state.queue = reads.ok({ signals: [] });
    expect(text(page())).toMatch(/Nothing else is waiting on you\./);
  });

  it("no proposal left but questions wait: a door to Review, never a calm done", () => {
    reset();
    state.status = "approved";
    state.queue = reads.ok({
      signals: [reads.ask("a"), reads.ask("b"), reads.ask("c")],
    });
    const html = page();
    expect(text(html)).toMatch(/3 more waiting in Review/);
    expect(html).toContain('data-review-next="review"');
    expect(html).toMatch(/href="\/review"/);
    expect(text(html)).not.toMatch(/Nothing else is waiting/);
  });

  it("a failed read of what is next says so", () => {
    reset();
    state.status = "approved";
    state.queue = reads.fail("INTERNAL_SERVER_ERROR");
    expect(text(page())).toMatch(/What waits next couldn’t be read\. Retry/);
  });

  it("the dock (Review beside it) never draws it", () => {
    reset();
    state.status = "approved";
    expect(dock()).not.toContain("data-review-next");
  });
});

describe("the review body — where 'what is next' may stand", () => {
  /** A background approval, as `approvalProgress` returns it. */
  const run = (runState: string) => ({
    runId: "r1",
    proposalId: PROPOSAL_ID,
    state: runState,
    phase: "entities",
    total: 40,
    done: 12,
    created: 12,
    linked: 0,
    failed: 0,
    error: null,
    primaryId: null,
    sessionId: null,
    relationsFailed: 0,
  });
  const body = (status: string) =>
    renderToStaticMarkup(
      <ProposalReviewBody
        proposal={{ ...PROPOSAL, status } as never}
        sourceExits={[]}
        workspaceName={null}
        onDecided={() => {}}
        afterDecision={<span data-after-decision="" />}
      />
    );

  it("under the outcome of a decided proposal", () => {
    reset();
    expect(body("approved")).toContain("data-after-decision");
  });

  it("under a background apply still reading pending (decided here)", () => {
    reset();
    state.progress = run("running");
    const html = body("pending");
    expect(html).toContain("data-after-decision");
    expect(text(html)).not.toMatch(/Reject…/);
  });

  it("never beside verbs still owed: approval failed, a stopped run, pending", () => {
    for (const [status, progress] of [
      ["approval_failed", null],
      ["pending", run("failed")],
      ["pending", null],
    ] as const) {
      reset();
      state.progress = progress;
      const html = body(status);
      expect(text(html)).toMatch(/Reject…/);
      expect(html).not.toContain("data-after-decision");
    }
  });
});

/**
 * The page's width follows what the review draws (founder, 2026-11-01: a
 * proposal that shows text reads at a document's width). The card is `auto`;
 * the body marks itself `data-reads-wide` when a field is prose, code or a
 * text diff, and the card widens on that mark (`receiverWidthClass`).
 */
describe("the /proposal page — reads wide when the review shows text", () => {
  const AUTO = "has-[[data-reads-wide]]:max-w-6xl";

  it("a change of short values stays at the default width", () => {
    const html = page();
    expect(html).toContain(AUTO);
    expect(html).not.toContain("data-reads-wide=");
  });

  it("a field rewritten as prose marks the review wide", () => {
    const prose = (lead: string) =>
      `${lead}\n${"Every search tool goes through the capability gate. ".repeat(4)}`;
    state.proposal = {
      review: {
        ...PROPOSAL.review,
        changes: [
          {
            path: "description",
            label: "Description",
            operation: "update",
            before: prose("Before."),
            after: prose("After."),
            valueType: "string",
            drift: "unchanged",
          },
        ],
      },
    };
    try {
      const html = page();
      expect(html).toContain(AUTO);
      expect(count(html, /data-reads-wide=""/)).toBe(1);
    } finally {
      state.proposal = {};
    }
  });
});
