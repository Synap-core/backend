/**
 * The goal page a goal link lands on: the REAL `GoalObject` over the shared
 * goal model, against a tRPC stub that answers the goal read. What it must
 * show is decided by `@synap-core/types/goal`; these tests pin that the page
 * draws it — Done when first, its count, every criterion — and that the
 * judge's verbs reach the judge only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const GOAL = "8ee85334-618c-4b5f-b918-7478337ee227";
const PROJECT = "d4b84ad8-6fbe-4c09-9cee-5715be1637d9";

const h = vi.hoisted(() => ({
  goal: null as unknown,
  viewerId: "" as string,
}));

vi.mock("../../../../lib/trpc", () => {
  const query = (data: () => unknown) => ({
    useQuery: () => ({
      data: data(),
      isLoading: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: () => undefined,
    }),
  });
  const mutation = {
    useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
  return {
    trpc: {
      useUtils: () => ({}),
      tracks: {
        get: query(() => h.goal),
        acceptCriterion: mutation,
        setStatus: mutation,
        reopen: mutation,
      },
      users: { me: query(() => ({ id: h.viewerId })) },
      projects: { get: query(() => ({ id: PROJECT, name: "Synap" })) },
      focusSessions: {
        list: query(() => [
          {
            id: "s-1",
            status: "active",
            title: "Resolver learns goals",
            goal: null,
          },
        ]),
      },
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../lib/exit-link", () => ({
  ExitLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../use-reauth", () => ({ useReauthOnUnauthorized: () => undefined }));

import { goalCriteriaCount, type GoalLike } from "@synap-core/types/goal";
import { ObjectPage } from "../object-page";
import { GoalObject } from "./goal-object";
import type { ObjectFrame } from "./object-frame";

const FRAME: ObjectFrame = {
  loading: (label) => <p>{label}</p>,
  failure: ({ failure }) => <p>{failure.title}</p>,
  object: (props) => <ObjectPage {...props} />,
};

const criterion = (
  key: string,
  statement: string,
  extra: Record<string, unknown> = {}
) => ({
  key,
  statement,
  check: { kind: "judge" },
  checkKind: "judged",
  acceptance: null,
  mark: "not_started",
  acceptanceState: null,
  meaning: "judged",
  currentValue: null,
  claim: null,
  ...extra,
});

function goalWith(criteria: unknown[]): GoalLike & { projectId: string } {
  return {
    id: GOAL,
    projectId: PROJECT,
    name: "Intent-first work model",
    status: "active",
    verdict: null,
    verdictReason: null,
    direction: "Find the universal shape of intended work.",
    endState: "People and agents run real work as Goals on the founder's pod.",
    criteria: criteria as GoalLike["criteria"],
    dropConditions: ["Two weeks pass with no real goal used"],
    workKind: "project",
    uncertainty: "complicated",
    kindConfirmedBy: OWNER,
    inReview: false,
    waitingOn: [],
    participants: [
      {
        id: "p-1",
        principalKind: "person",
        principalId: OWNER,
        displayName: "Antoine Servant",
        role: "owner",
        commitment: null,
        commitmentState: null,
        counterText: null,
        reportedReason: null,
        reportedAt: null,
        acknowledgedAt: null,
        decidedBy: OWNER,
        decidedAt: "2026-10-23T00:28:58.755Z",
        createdAt: "2026-10-23T00:28:58.755Z",
      },
    ] as unknown as GoalLike["participants"],
    periodReading: null,
  };
}

const OPEN_CRITERIA = [
  criterion(
    "in-users-hands",
    "The goal pages are in the apps the founder runs."
  ),
  criterion(
    "judged-on-phone",
    "At least one real goal was closed by its judge."
  ),
];

const CLAIMED = criterion("review-clean", "Every must-fix is merged.", {
  mark: "claimed",
  acceptanceState: "waiting",
  claim: {
    by: "agent-1",
    byName: "Claude Code",
    sessionId: "s-1",
    sessionTitle: "Resolver learns goals",
    evidence: null,
    note: "PR #534 merged",
    at: "2026-10-30T12:00:00.000Z",
  },
});

const render = () =>
  renderToStaticMarkup(<GoalObject id={GOAL} frame={FRAME} />);

beforeEach(() => {
  h.viewerId = OWNER;
});

describe("GoalObject — what a goal link lands on", () => {
  it("leads with Done when: the end state, the count and every criterion", () => {
    h.goal = goalWith(OPEN_CRITERIA);
    const out = render();
    expect(out).toContain("Intent-first work model");
    expect(out).toContain("Done when");
    expect(out).toContain("People and agents run real work as Goals");
    const count = goalCriteriaCount(h.goal as GoalLike).label;
    expect(count).toBeTruthy();
    expect(out).toContain(count!);
    for (const c of OPEN_CRITERIA) expect(out).toContain(c.statement);
    expect(out).toContain("Two weeks pass with no real goal used");
    expect(out).toContain("Resolver learns goals"); // its session
    expect(out).toContain("Synap"); // its project
  });

  it("offers its owner, who judges it, Declare done — and no judge verb while nothing is claimed", () => {
    h.goal = goalWith(OPEN_CRITERIA);
    const out = render();
    expect(out).toContain("Declare done");
    expect(out).not.toContain("Send back");
  });

  it("a claimed criterion shows its claim and the judge's Accept / Send back", () => {
    h.goal = goalWith([...OPEN_CRITERIA, CLAIMED]);
    const out = render();
    expect(out).toContain("Claude Code");
    expect(out).toContain("PR #534 merged");
    expect(out).toContain("Accept");
    expect(out).toContain("Send back");
  });

  it("someone who is not its judge sees the claim but no verb and no Declare done", () => {
    h.viewerId = STRANGER;
    h.goal = goalWith([...OPEN_CRITERIA, CLAIMED]);
    const out = render();
    expect(out).toContain("Claude Code");
    expect(out).not.toContain("Send back");
    expect(out).not.toContain("Declare done");
    expect(out).toContain("Open in app");
  });
});
