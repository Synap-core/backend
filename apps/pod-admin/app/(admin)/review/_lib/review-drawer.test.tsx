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
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GOVERNANCE_POLICY_SENTENCES,
  GOVERNANCE_REASON_SHORT_LABELS,
} from "@synap-core/types/proposals";

/** The reason mark, read from its one home (`GOVERNANCE_REASON_SHORT_LABELS`). */
const IDENTITY_MARK = GOVERNANCE_REASON_SHORT_LABELS.SCOPE_IDENTITY_CHANGE!;
import { resolveActionLabel } from "@synap-core/types/vocabulary";

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
  NEXT_ID,
  NAME,
  PROPOSAL,
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
  /** The session's newest timeline items, oldest first (`readSessionTimelines`). */
  const AGENT = { kind: "agent", id: AGENT_ID, name: "Claude-code" };
  const SYSTEM = { kind: "system", id: null, name: null };
  let minute = 0;
  const at = () => new Date(Date.UTC(2026, 10, 16, 9, minute++)).toISOString();
  const checks = (id: string, result: "passed" | "failed") => ({
    id,
    kind: "checks_finished",
    at: at(),
    actor: SYSTEM,
    refs: { sessionId: SESSION_ID },
    checks: {
      repo: "o/r",
      sha: "abc1234",
      result,
      status: "success",
      pr: 7,
      job: null,
      workflow: "CI",
    },
  });
  const EVENTS = [
    {
      id: "e-start",
      kind: "session_started",
      at: at(),
      actor: AGENT,
      refs: { sessionId: SESSION_ID },
      title: "Build wave 2",
    },
    checks("e-c1", "failed"),
    checks("e-c2", "failed"),
    checks("e-c3", "passed"),
    {
      id: "e-pr",
      kind: "pr_opened",
      at: at(),
      actor: AGENT,
      refs: { sessionId: SESSION_ID, url: "https://github.com/o/r/pull/7" },
      pr: {
        repo: "o/r",
        number: 7,
        url: "https://github.com/o/r/pull/7",
        title: null,
      },
      intoDefault: null,
    },
    {
      id: "e-asked",
      kind: "decision_asked",
      at: at(),
      actor: AGENT,
      refs: { sessionId: SESSION_ID, proposalId: PROPOSAL_ID },
      title: NAME,
    },
  ];
  const WAITER_ID = "88888888-8888-4888-8888-888888888888";
  const SESSION_PARTS = {
    timeline: {
      status: "ok",
      // Newest first, as the read returns it.
      value: { events: [...EVENTS].reverse(), olderExist: false },
    },
    aiCanDo: { status: "ok", value: { items: [], total: 0 } },
    waiting: {
      status: "ok",
      value: {
        items: [{ id: WAITER_ID, title: "Ship the gate", status: "active" }],
        total: 1,
      },
    },
  };
  /** `signals.needsYou({ include: ["context"] })`: this proposal's row and its story. */
  const contextOf = (sessionParts: Record<string, unknown> = SESSION_PARTS) =>
    ok({
      rows: {
        needs_you: [
          {
            ...cluster(PROPOSAL_ID, NAME),
            source: { kind: "session", id: SESSION_ID, label: "Build wave 2" },
          },
        ],
      },
      context: {
        timelineItems: 4,
        sessions: { [SESSION_ID]: sessionParts },
        rows: {
          [`proposal-cluster:${PROPOSAL_ID}`]: {
            sessionId: SESSION_ID,
            slotLabel: null,
            proposalIds: [PROPOSAL_ID],
            proposalWaits: {
              status: "ok",
              value: { waits: true, reason: "gate" },
            },
          },
        },
      },
    });
  const state = {
    status: "pending",
    /** `signals.needsYou` with its context: the request's story. */
    context: contextOf() as Q,
    /** `proposals.repairOptions`: what a proposal still needs from you. */
    repairOptions: {
      proposalId: "p",
      repairable: false,
      fields: [],
    } as Record<string, unknown>,
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
    /** `proposals.source`: where the proposal came from (answered by default). */
    source: { data: { targets: TARGETS }, isFetched: true, isError: false } as {
      data?: unknown;
      isFetched: boolean;
      isError: boolean;
    },
    /** Every `signals.needsYou` call: its input and whether it was enabled. */
    needsYouCalls: [] as Array<{ sessionId?: unknown; enabled: boolean }>,
  };
  const reads = { ok, fail, cluster, ask, SESSION, SESSION_PARTS, contextOf };
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
        isError: r.error !== undefined,
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

/* The phone drawer's frame (a modal: nothing to draw on a server render),
   drawn in place with the head its host hands it. */
vi.mock("../../components/detail-drawer", () => ({
  DetailDrawer: ({
    header,
    children,
  }: {
    header?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-detail-drawer="">
      <div data-detail-drawer-header="">{header}</div>
      {children}
    </div>
  ),
}));

vi.mock("../../../../lib/trpc", async () => ({
  trpc: {
    presence: (
      await import("../../../_lib/presence/__tests__/trpc-double")
    ).presenceTrpcDouble(),
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
      source: {
        useQuery: () => ({ ...state.source, refetch() {} }),
      },
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
      revise: { useMutation: () => ({ mutate() {}, isPending: false }) },
      // The failed-approval card (`FailedApproval.tsx`): nothing to fix here.
      repairOptions: {
        useQuery: () => ({
          data: state.repairOptions,
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
      needsYou: {
        useQuery: (
          input: Record<string, unknown>,
          opts?: { enabled?: boolean }
        ) => {
          state.needsYouCalls.push({
            sessionId: input.sessionId,
            enabled: opts?.enabled !== false,
          });
          return query(() => state.context)(input, opts);
        },
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

import { ReviewDock, ReviewDrawer } from "./review-drawer";
import { en as REQUEST_EN } from "../../../_lib/request/copy";
import { en as PAGE_EN } from "../../../proposal/[id]/copy";
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

/** The fixture's state, laid back after every test (S13: never a reset on a test's last line). */
const DEFAULTS = { ...state };
afterEach(() => {
  Object.assign(state, DEFAULTS);
  state.needsYouCalls = [];
});

/** The reader: by default the person the agent acts for. */
const READER = "Ada Lovelace";
/** A proposal's trigger: its verb, reject, from the vocabulary door. */
const REFUSE = `${resolveActionLabel("reject", "imperative")}…`;

const dock = (identity = READER) =>
  renderToStaticMarkup(
    <ReviewDock
      open={{
        detail: { kind: "proposal", proposalId: PROPOSAL_ID },
        title: `Update "${NAME}"`,
      }}
      viewer={{ identity, podHost: "pod.example.test" }}
      onClose={() => {}}
      liveAsk={null}
      onAskSettled={() => {}}
    />
  );

const page = (identity = READER) =>
  renderToStaticMarkup(
    <ProposalReview
      proposalId={PROPOSAL_ID}
      podHost="pod.example.test"
      identity={identity}
    />
  );

/** The request's one head: its row of chips, up to what is decided. */
const headOf = (html: string) => {
  const at = html.indexOf("data-story-head");
  expect(at, "the head is drawn").toBeGreaterThanOrEqual(0);
  return html.slice(at, html.indexOf('data-story-node="now"', at));
};

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

  it("the head at the top: the agent, 'for you', the session (a door) and when, as one row of chips", () => {
    const html = render();
    const head = headOf(html);
    expect(head).toContain('data-review-provenance=""');
    expect(head).toMatch(/data-head-part="agent"[^>]*>Claude-code</);
    // The person it acts for IS the reader: said "for you", never their name.
    expect(text(head)).toMatch(/\bfor you\b/);
    expect(text(head)).not.toContain(READER);
    expect(head).toMatch(/data-head-part="session"[^>]*>Build wave 2</);
    expect(head).toContain(`href="/open/session/${SESSION_ID}"`);
    // The absolute date rides on the relative one, for hover.
    expect(head).toMatch(
      /<time data-head-part="age" dateTime="[^"]+" title="[^"]+">1d ago<\/time>/
    );
    // At the top: before what is decided.
    expect(html.indexOf("data-story-head")).toBeLessThan(
      html.indexOf('data-story-node="now"')
    );
  });

  it("the head names the person it acts for when the reader is someone else", () => {
    const head = text(headOf(render("Grace Hopper")));
    expect(head).toContain(READER);
    expect(head).not.toMatch(/\bfor you\b/);
  });

  it("the change comes first, in words: Kind Finding → Issue", () => {
    const seen = text(render());
    expect(seen).toMatch(/Kind Finding Issue/);
    expect(seen).not.toMatch(/ProfileSlug/);
    expect(seen.indexOf("Finding")).toBeLessThan(seen.indexOf(IDENTITY_MARK));
  });

  it("why: the reason as ONE mark (its sentence behind it), the proposer's words as theirs", () => {
    const html = render();
    const seen = text(html);
    expect(html).toContain(`data-review-mark="${IDENTITY_MARK}"`);
    // The sentence is read from its one home, so a rewording never reds this.
    expect(seen).not.toContain(
      GOVERNANCE_POLICY_SENTENCES.SCOPE_IDENTITY_CHANGE
    );
    // Theirs, without naming them again: the head names who asked, once.
    expect(seen).toContain(
      `${PAGE_EN["review.note"]} Product problems move from finding to issue.`
    );
  });

  it("the decision bar: the verbs, what refusing does, who decides", () => {
    const html = render();
    expect(count(html, /data-review-decision/)).toBe(1);
    const at = html.indexOf("data-review-decision");
    const bar = html.slice(at, html.indexOf("Advanced", at));
    const seen = text(bar);
    expect(seen).toMatch(/Can't be undone/);
    // Approve, then the ONE Refuse trigger; the verb is Refuse, never Reject.
    expect(bar).toContain(">Approve<");
    expect(count(bar, /data-refuse-trigger/)).toBe(1);
    expect(bar.indexOf(">Approve<")).toBeLessThan(bar.indexOf(REFUSE));
    // A proposal is rejected (the verb follows the object): never Refuse.
    expect(text(html)).not.toMatch(/\bRefuse\b/);
    // What rejecting does, without naming the requester again (the head does).
    const refusing = text(bar.slice(bar.indexOf("data-review-refusing")));
    expect(refusing).toContain(REQUEST_EN["refuse.proposalConsequenceAgent"]);
    expect(seen).toMatch(
      /You decide as Ada Lovelace · recorded in the Audit log/
    );
    // The bar is the story's footer: after the timeline; Advanced is last.
    expect(at).toBeGreaterThan(html.indexOf("</ol>"));
    expect(html.indexOf("Advanced")).toBeGreaterThan(at);
  });

  // Founder, 17 Nov 2026: "no duplication". Each of who asked, for whom, the
  // session and the age is named exactly once on the page: in the head.
  it("ONE head; the agent, the person, the session and the age each named exactly once", () => {
    const html = render();
    expect(count(html, /data-story-head/)).toBe(1);
    const seen = text(html);
    expect(count(seen, /Claude-code/)).toBe(1);
    expect(count(seen, /\bfor you\b/)).toBe(1);
    expect(count(seen, /Build wave 2/)).toBe(1);
    expect(count(seen, /\b1d ago\b/)).toBe(1);
    for (const part of ["agent", "person", "session", "age"])
      expect(count(html, new RegExp(`data-head-part="${part}"`))).toBe(1);
  });
});

/**
 * The founder-approved order (who → what the session is for → the change →
 * why → decide → Advanced) told as ONE story (option B, 16 Nov 2026): who and
 * what for in BEFORE, the change, why and the decision in NOW, what deciding
 * moves in NEXT (dashed), Advanced last. Same order, now inside the story.
 */
const at = (html: string, marker: string) => {
  const i = html.indexOf(marker);
  expect(i, `${marker} is drawn`).toBeGreaterThanOrEqual(0);
  return i;
};

describe.each([
  ["the Review dock", () => dock()],
  ["the /proposal page", () => page()],
])("%s — the request as one story", (_host, render) => {
  it("Before holds who asked; Now the change, why and what holds; Next follows; the bar, then depth, then Advanced", () => {
    const html = render();
    const before = at(html, 'data-story-node="before"');
    const head = at(html, "data-story-head");
    const now = at(html, 'data-story-node="now"');
    const change = at(html, IDENTITY_MARK);
    const after = at(html, 'data-story-node="after"');
    const decision = at(html, "data-review-decision");
    const provenance = at(html, "data-review-provenance");
    const advanced = html.indexOf("Advanced");
    expect(before).toBeLessThan(head);
    // Who asked is the head's one row of chips, at the top.
    expect(head).toBeLessThan(provenance);
    expect(provenance).toBeLessThan(now);
    expect(head).toBeLessThan(now);
    expect(now).toBeLessThan(change);
    expect(change).toBeLessThan(after);
    // The decision bar is the story's footer: never inside Now.
    expect(after).toBeLessThan(decision);
    expect(decision).toBeLessThan(advanced);
    // What the session is for is not drawn here: its chip is the door.
    expect(html).not.toContain("data-review-session");
    // The change still comes first inside Now (in words, before the mark).
    expect(text(html.slice(now))).toMatch(/Kind Finding Issue/);
  });

  // Founder, 17 Nov 2026: the past is THIS request's. The fixture's session
  // timeline holds only the session's checks, PRs and start: none is this
  // proposal's, so no past line and no fold.
  it("the past keeps only this request's own events: the session's checks, PRs and start are gone", () => {
    const html = render();
    const pastHtml = html.slice(
      at(html, 'data-story-node="before"'),
      at(html, 'data-story-node="now"')
    );
    expect(pastHtml).not.toContain("data-story-event");
    expect(pastHtml).not.toContain("data-story-fold");
    const past = text(pastHtml);
    expect(past).not.toMatch(
      /Checks (passed|failed)|Opened o\/r#7|Session started/
    );
  });

  it("what holds on the decision is said in Now; Next names what waits, each a door", () => {
    const html = render();
    const now = html.slice(
      at(html, 'data-story-node="now"'),
      at(html, 'data-story-node="after"')
    );
    // An agent that waits says what holds NOW, not what comes next.
    expect(now).toContain('data-story-after="agent_waits"');
    expect(text(now)).toMatch(/until you decide/);
    const next = html.slice(
      at(html, 'data-story-node="after"'),
      at(html, "data-review-decision")
    );
    expect(next).not.toContain('data-story-after="agent_waits"');
    // First what approving does, then the sessions that wait.
    expect(next.indexOf('data-story-after="approve"')).toBeLessThan(
      next.indexOf('data-story-after="sessions_wait"')
    );
    expect(text(next)).toMatch(/1 session waits on this Ship the gate/);
    expect(next).toContain(
      'href="/open/session/88888888-8888-4888-8888-888888888888"'
    );
  });

  it("a part whose read failed says so where it belongs — never 'nothing waits'", () => {
    Object.assign(state, {
      context: reads.contextOf({
        ...reads.SESSION_PARTS,
        waiting: { status: "unreadable" },
      }),
    });
    const seen = text(render());
    expect(seen).toMatch(/Which sessions wait on this could not be read\./);
    expect(seen).not.toMatch(/Nothing else waits on this/);
  });

  it("a failed context read says so with a retry, and the decision stays", () => {
    Object.assign(state, { context: reads.fail("INTERNAL_SERVER_ERROR") });
    const html = render();
    expect(text(html)).toMatch(
      /What led here and what comes next could not be read\. Try again/
    );
    expect(count(html, /data-review-decision/)).toBe(1);
  });
});

/** An install that needs its key (finding 91a3bfd3, founder default B5). */
const SETUP = {
  blocking: true,
  params: [
    {
      name: "apiKey",
      label: "Cal.com API key",
      required: true,
      secret: true,
      satisfied: false,
      obtain: {
        url: "https://app.cal.com/settings/developer/api-keys",
        steps: ["Open Settings, then Developer", "Create a key"],
      },
    },
  ],
};

describe.each([
  ["the Review dock", () => dock()],
  ["the /proposal page", () => page()],
])("%s — a proposal that needs an input (B5)", (_host, render) => {
  it("Approve waits, with 'Fill in X first' in its place; the hand-over comes before the verbs", () => {
    Object.assign(state, {
      proposal: { setup: SETUP },
      repairOptions: {
        proposalId: PROPOSAL_ID,
        repairable: true,
        fields: [],
        setup: {
          ...SETUP,
          secretChoices: [{ ref: "vault://s1", label: "CAL_KEY" }],
        },
      },
    });
    const html = render();
    const seen = text(html);
    expect(seen).toMatch(/Fill in Cal\.com API key first/);
    // The Approve button is disabled while the row is empty.
    const approve = html.slice(
      html.lastIndexOf("<button", html.indexOf(">Approve<")),
      html.indexOf(">Approve<")
    );
    expect(approve).toMatch(/disabled/);
    // What it needs: the row, how to get it, the page it starts on.
    const handOver = at(html, "data-setup-hand-over");
    expect(handOver).toBeLessThan(at(html, "data-review-decision"));
    expect(seen).toMatch(/Open Settings, then Developer Create a key/);
    expect(html).toContain(
      'href="https://app.cal.com/settings/developer/api-keys"'
    );
  });

  it("a failed approval that needs an input shows the hand-over row, not just the sentence", () => {
    Object.assign(state, {
      status: "approval_failed",
      proposal: { rejectionReason: "Needs setup: Cal.com API key." },
      repairOptions: {
        proposalId: PROPOSAL_ID,
        repairable: true,
        fields: [],
        setup: { ...SETUP, secretChoices: [] },
      },
    });
    const html = render();
    const failed = html.slice(at(html, "data-failed-approval"));
    expect(failed).toContain("data-setup-hand-over");
    expect(text(failed)).toMatch(/Needs setup: Cal\.com API key\./);
    expect(text(failed)).toMatch(/Cal\.com API key/);
  });

  it("what it needs cannot be told: Approve waits, and says why", () => {
    const unreadable = { blocking: true, params: [], unreadable: true };
    Object.assign(state, {
      proposal: { setup: unreadable },
      repairOptions: {
        proposalId: PROPOSAL_ID,
        repairable: false,
        fields: [],
        setup: { ...unreadable, secretChoices: [] },
      },
    });
    const html = render();
    const seen = text(html);
    // Said ONCE, in the bar beside the verb that waits (the hand-over above
    // draws no second copy).
    expect(count(seen, /Synap cannot tell what this needs/)).toBe(1);
    const bar = html.slice(at(html, "data-review-decision"));
    expect(bar).toContain('data-setup-block="unreadable"');
    const approve = html.slice(
      html.lastIndexOf("<button", html.indexOf(">Approve<")),
      html.indexOf(">Approve<")
    );
    expect(approve).toMatch(/disabled/);
  });

  it("nothing to hand over: Approve does not wait", () => {
    const html = render();
    expect(text(html)).not.toMatch(/Fill in .* first/);
    expect(html).not.toContain("data-setup-hand-over");
  });
});

// Founder, 17 Nov 2026: when the story says nothing the head and the bar do
// not (no own past, nothing waiting beyond the consequence), Now is drawn
// flat and what approving does is said once, in the bar.
describe.each([
  ["the Review dock", dock],
  ["the /proposal page", page],
])("%s — nothing more to tell: no rail", (_host, render) => {
  it("no rail and no Now/Next labels; 'If you approve' joins the bar's line, once", () => {
    Object.assign(state, {
      context: reads.contextOf({
        ...reads.SESSION_PARTS,
        waiting: { status: "ok", value: { items: [], total: 0 } },
      }),
    });
    const html = render();
    expect(html).toContain("data-story-flat");
    expect(html).not.toContain("data-request-story");
    expect(html).not.toMatch(/rq-rail-|rq-mark-now/);
    const approve = REQUEST_EN["story.approveDoes"].split("{change}")[0]!;
    expect(count(text(html), new RegExp(approve))).toBe(1);
    const bar = html.slice(html.indexOf("data-review-decision"));
    expect(text(bar)).toContain(approve);
  });
});

// Founder, 17 Nov 2026: what the session is for (goal, criteria, track,
// project, how many more wait) is work status, and pod admin is not a work
// surface. The head's session chip is the door to it.
describe.each([
  ["the Review dock", dock],
  ["the /proposal page", page],
])("%s — what the session is for is not drawn", (_host, render) => {
  it("no goal, criteria, track, project or 'more waiting' on the request", () => {
    const html = render();
    expect(html).not.toContain("data-review-session");
    expect(text(html)).not.toMatch(
      /Every search tool goes through the capability gate|criteria met|Hardening Synap|more waiting/
    );
    expect(html).not.toContain(`href="/open/track/${TRACK_ID}"`);
  });
});

describe("the /proposal page — the next waiting proposal", () => {
  it("while it is still to decide: no next door", () => {
    expect(page()).not.toContain("data-review-next");
  });

  it("decided: a door to the first proposal Review lists", () => {
    state.status = "approved";
    const html = page();
    expect(html).toContain(`data-review-next="${NEXT_ID}"`);
    expect(html).toContain(`href="/proposal/${NEXT_ID}"`);
    expect(text(html)).toMatch(/Next in your queue\s+Create Linus/);
  });

  it("nothing else at all: said calmly, in Review's own words", () => {
    state.status = "rejected";
    state.queue = reads.ok({ signals: [] });
    expect(text(page())).toMatch(/Nothing else is waiting on you\./);
  });

  it("no proposal left but questions wait: a door to Review, never a calm done", () => {
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
    state.status = "approved";
    state.queue = reads.fail("INTERNAL_SERVER_ERROR");
    expect(text(page())).toMatch(/What waits next couldn’t be read\. Retry/);
  });

  it("the dock (Review beside it) never draws it", () => {
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
    expect(body("approved")).toContain("data-after-decision");
  });

  it("under a background apply still reading pending (decided here)", () => {
    state.progress = run("running");
    const html = body("pending");
    expect(html).toContain("data-after-decision");
    expect(text(html)).not.toContain(REFUSE);
  });

  it("never beside verbs still owed: approval failed, a stopped run, pending", () => {
    for (const [status, progress] of [
      ["approval_failed", null],
      ["pending", run("failed")],
      ["pending", null],
    ] as const) {
      state.progress = progress;
      const html = body(status);
      expect(text(html)).toContain(REFUSE);
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
    const html = page();
    expect(html).toContain(AUTO);
    expect(count(html, /data-reads-wide=""/)).toBe(1);
  });
});

/**
 * The detail's head (code review M2): the request's kind tile beside its
 * title, the same mark the row draws — docked, and in the phone drawer
 * through `DetailDrawer`'s `header`.
 */
describe("the detail's head — the kind tile beside the title", () => {
  const open = {
    detail: { kind: "proposal" as const, proposalId: PROPOSAL_ID },
    title: `Update "${NAME}"`,
    family: "change" as const,
    noun: "Finding",
    sentence: "Product problems move from finding to issue.",
  };
  const headOf = (html: string, from: string) => {
    const at = html.indexOf(from);
    expect(at, `${from} is drawn`).toBeGreaterThanOrEqual(0);
    return html.slice(at, html.indexOf("</header>", at));
  };
  const assertHead = (head: string) => {
    const tile = head.indexOf('data-request-family="change"');
    expect(tile).toBeGreaterThanOrEqual(0);
    // The tile is named by the kind noun, and is neutral (colour = state).
    expect(head).toMatch(
      /role="img" aria-label="Finding"[^>]*data-request-family="change"/
    );
    expect(head).toContain("rq-tile-neutral");
    // Beside the title, before it; the sentence under it.
    expect(tile).toBeLessThan(head.indexOf("<h2"));
    expect(text(head)).toContain(`Update "${NAME}"`);
    expect(text(head)).toContain(open.sentence);
  };

  it("the dock draws the tile beside the title", () => {
    const html = renderToStaticMarkup(
      <ReviewDock
        open={open}
        viewer={{ identity: READER }}
        onClose={() => {}}
        liveAsk={null}
        onAskSettled={() => {}}
      />
    );
    assertHead(headOf(html, "<header"));
  });

  it("the phone drawer draws the same head, through DetailDrawer's header", () => {
    const html = renderToStaticMarkup(
      <ReviewDrawer
        open={open}
        viewer={{ identity: READER }}
        onClose={() => {}}
        liveAsk={null}
        onAskSettled={() => {}}
      />
    );
    const header = html.slice(
      html.indexOf("data-detail-drawer-header"),
      html.indexOf("</header>") + 1
    );
    assertHead(headOf(header, "<header"));
  });
});

/**
 * `/proposal/[id]` reads its story narrowed to the proposal's session: the
 * read waits on `proposals.source` (S4), so it is never pod-wide first, and a
 * failed source read is the story's failed read — never an empty past.
 */
describe("the /proposal page — the story waits on where it came from", () => {
  it("while the source read is in flight, the story is not read", () => {
    state.source = { data: undefined, isFetched: false, isError: false };
    page();
    expect(state.needsYouCalls.length).toBeGreaterThan(0);
    expect(state.needsYouCalls.every((c) => !c.enabled)).toBe(true);
  });

  it("once it answered, the story is read narrowed to the proposal's session", () => {
    page();
    const enabled = state.needsYouCalls.filter((c) => c.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every((c) => c.sessionId === SESSION_ID)).toBe(true);
  });

  it("a failed source read shows the story's failed read, with Try again, and the decision stays", () => {
    state.source = { data: undefined, isFetched: false, isError: true };
    const html = page();
    expect(html).toContain('data-story-unreadable="all"');
    expect(text(html)).toContain(REQUEST_EN["story.failed"]);
    expect(text(html)).toContain(REQUEST_EN["story.retry"]);
    expect(count(html, /data-review-decision/)).toBe(1);
  });
});
