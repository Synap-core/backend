/**
 * The session page's Needs you and Proposed changes, RENDERED (react-dom/server;
 * pod-admin's vitest runs in node) against a tRPC client that records what
 * each read was asked and what each door was sent.
 *
 *   • Needs you draws this session's owed asks — the question, its options,
 *     the agent's recommendation marked — and answering one goes out through
 *     `focusSessions.answerOutput`, the door Review's answer sends to, with the
 *     slot's label and the fingerprint of the ask the reader saw. "Send
 *     answer" is pressed by calling the press handler the real control drew.
 *   • A session with nothing owed draws no Needs you at all.
 *   • Proposed changes lists only this session's pending proposals, each a
 *     door to its review.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { askFingerprint, type Ask } from "@synap-core/types/ask";

const {
  SESSION_ID,
  ASK,
  owedHere,
  owedElsewhere,
  criterionSlot,
  criterionSlotOpenAsk,
  cluster,
  proposalHere,
  proposalElsewhere,
  calls,
  buttons,
  seen,
} = vi.hoisted(() => {
  const SESSION_ID = "6f1c2c1e-0000-4000-8000-000000000001";
  const OTHER_SESSION_ID = "6f1c2c1e-0000-4000-8000-000000000002";
  const ASK = {
    mode: "choose",
    options: [
      { label: "Ship Monday", value: "monday" },
      { label: "Ship Friday", value: "friday", recommended: true },
    ],
  } as const;
  const signal = (over: Record<string, unknown>) => ({
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    occurredAt: "2026-10-24T09:00:00.000Z",
    category: "ai",
    ...over,
  });
  const owedHere = signal({
    id: "owed:here",
    kind: "owed-slot",
    title: "Which day do we ship?",
    why: "The launch post needs a date.",
    blockedReason: "decision",
    slotKind: "decision",
    ask: ASK,
    sessionTitle: "Launch plan",
    target: { kind: "session", id: SESSION_ID },
    // The asker, named by the pod on the signal (`askedBy` → `by`).
    by: {
      kind: "agent",
      id: "a0000000-0000-4000-8000-000000000001",
      label: "Claude-code",
    },
  });
  const owedElsewhere = signal({
    id: "owed:elsewhere",
    kind: "owed-slot",
    title: "Pick the other session's logo",
    ask: ASK,
    target: { kind: "session", id: OTHER_SESSION_ID },
  });
  // An escalated criterion, handed to the person to grade (`CRITERION_SLOT_ASK`).
  const criterionSlot = signal({
    id: "owed:criterion",
    kind: "owed-slot",
    title: "Check: Relay offers the same turn-on doors",
    why: "Checked 2 times and still not passing — mark it pass or fail.",
    blockedReason: "decision",
    slotKind: "criterion",
    criterionKey: "relay-approve",
    ask: {
      mode: "choose",
      options: [
        { label: "Pass", value: "pass" },
        { label: "Fail", value: "fail" },
      ],
    },
    target: { kind: "session", id: SESSION_ID },
  });
  // A criterion slot whose ask an agent rewrote: not a grade, graded elsewhere.
  const criterionSlotOpenAsk = signal({
    id: "owed:criterion-open",
    kind: "owed-slot",
    title: "Check: The Rules page turns a draft rule on",
    slotKind: "criterion",
    criterionKey: "activate-draft-rule",
    ask: {
      mode: "choose",
      allowOther: true,
      options: [{ label: "Pass", value: "pass" }],
    },
    target: { kind: "session", id: SESSION_ID },
  });
  const cluster = signal({
    id: "cluster:1",
    kind: "proposal-cluster",
    title: "Create task",
    class: "objectWork",
    target: { kind: "proposal", id: "7a000000-0000-4000-8000-000000000001" },
  });
  const proposal = (id: string, name: string, status = "pending") => ({
    id,
    status,
    proposalType: "create",
    targetType: "task",
    targetName: name,
    createdAt: new Date("2026-10-24T08:00:00.000Z"),
    agentActorName: "Claude-code",
    data: {},
  });
  return {
    SESSION_ID,
    ASK,
    owedHere,
    owedElsewhere,
    criterionSlot,
    criterionSlotOpenAsk,
    cluster,
    proposalHere: proposal(
      "7a000000-0000-4000-8000-000000000001",
      "Draft the launch post"
    ),
    proposalElsewhere: proposal(
      "7a000000-0000-4000-8000-000000000002",
      "Another session's task"
    ),
    calls: [] as Array<[string, unknown]>,
    buttons: [] as Array<{ children?: unknown; onPress?: () => void }>,
    /** What the reads return, per test. */
    seen: {
      signals: [] as unknown[],
      proposals: [] as unknown[],
      /** A read that failed: with no data yet, or a poll after a good read. */
      failed: { signals: null, proposals: null } as Record<
        "signals" | "proposals",
        null | "first-read" | "poll"
      >,
    },
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => `/sessions/${SESSION_ID}`,
  useRouter: () => ({ replace() {}, push() {} }),
}));

// The real controls, with Button swapped for one that hands its press
// handler to the test — node has no DOM to click in.
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Button: (props: { children?: unknown; onPress?: () => void }) => {
      buttons.push(props);
      return createElement(
        "button",
        { type: "button" },
        props.children as never
      );
    },
  };
});

vi.mock("../../../../lib/trpc", () => {
  const door = (name: string) => ({
    useMutation: () => ({
      mutate: (input: unknown) => calls.push([name, input]),
      isPending: false,
      error: null,
    }),
  });
  return {
    POD_URL: "https://pod.example.test",
    trpc: {
      useUtils: () => ({}),
      signals: {
        list: {
          useQuery: (input: { sessionId?: string }) => {
            calls.push(["signals.list", input]);
            // The pod narrows to the session it is asked about; asked for
            // none, it answers with every session's.
            const all = seen.signals as Array<{
              target?: { id?: string } | null;
            }>;
            const failed = seen.failed.signals;
            return {
              data:
                failed === "first-read"
                  ? undefined
                  : {
                      signals: input.sessionId
                        ? all.filter(
                            (s) =>
                              s.target?.id === input.sessionId ||
                              (s as { kind?: string }).kind ===
                                "proposal-cluster"
                          )
                        : all,
                    },
              isLoading: false,
              error: failed ? new Error("pod unreachable") : null,
              dataUpdatedAt: 1,
              refetch() {},
            };
          },
        },
      },
      proposals: {
        list: {
          useQuery: (input: { sessionId?: string }) => {
            calls.push(["proposals.list", input]);
            const all = seen.proposals as Array<{ id: string }>;
            const failed = seen.failed.proposals;
            return {
              data:
                failed === "first-read"
                  ? undefined
                  : {
                      items: input.sessionId
                        ? all.filter((p) => p.id === proposalHere.id)
                        : all,
                      pagination: { hasMore: false },
                    },
              isLoading: false,
              error: failed ? new Error("pod unreachable") : null,
              refetch() {},
            };
          },
        },
      },
      focusSessions: {
        get: {
          useQuery: () => ({
            data: { participants: [{ name: "Claude-code" }] },
          }),
        },
        answerOutput: door("focusSessions.answerOutput"),
        attestOutput: door("focusSessions.attestOutput"),
        unblockOutput: door("focusSessions.unblockOutput"),
        askAboutSlot: door("focusSessions.askAboutSlot"),
      },
    },
  };
});

import {
  CriterionGrade,
  criterionGradeSignals,
  NeedsYouSection,
  ProposedChangesSection,
} from "./session-needs-you";
import { AskAnswer } from "../../../(admin)/review/_lib/ask-answer";
import { reviewRows } from "../../../(admin)/review/_lib/review-rows";

/** Visible text only — attributes and tags stripped. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

afterEach(() => {
  seen.failed.signals = null;
  seen.failed.proposals = null;
});

function render(node: ReactElement): string {
  calls.length = 0;
  buttons.length = 0;
  return renderToStaticMarkup(node);
}

describe("Needs you — the session's own asks, answered in place", () => {
  it("draws this session's ask: the question, its options, the recommendation marked", () => {
    seen.signals = [owedHere, owedElsewhere, cluster];
    const html = render(<NeedsYouSection sessionId={SESSION_ID} />);
    const seenText = text(html);

    expect(calls).toContainEqual([
      "signals.list",
      expect.objectContaining({ lens: "needs-you", sessionId: SESSION_ID }),
    ]);
    expect(seenText).toContain("Needs you");
    expect(seenText).toContain("Which day do we ship?");
    expect(seenText).toContain("The launch post needs a date.");
    expect(seenText).toMatch(/Ship Monday .*Ship Friday Recommended/);
    expect(seenText.match(/Recommended/g)).toHaveLength(1);
    // Another session's ask, and a proposal (its own section), are not here.
    expect(seenText).not.toContain("Pick the other session's logo");
    expect(seenText).not.toContain("Create task");
    // The asker is a NAMED mark (decision 4, 2026-10-26): never a sentence,
    // never "An agent", never "It is waiting on your answer".
    expect(seenText).toContain("Claude-code");
    expect(seenText).not.toMatch(
      /An agent|waiting on your answer|Who is asking/
    );
    // On its own page the mark is no door back to the session.
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>)[\s\S])*Claude-code/);
    expect(seenText).not.toContain("Launch plan");
  });

  it("everywhere else (Review) the asker's mark is the door to its session", () => {
    const row = reviewRows([owedHere] as never, new Map())[0];
    if (row?.detail?.kind !== "ask") throw new Error("expected an ask row");
    const html = render(
      <AskAnswer
        slot={row.detail.slot}
        live={row.detail.slot}
        onSettled={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toMatch(
      /<a [^>]*href="[^"]+"[^>]*>(?:(?!<\/a>)[\s\S])*Claude-code/
    );
    expect(text(html)).not.toMatch(/An agent|waiting on your answer/);
  });

  it("the founder's card (2026-10-26): the question ONCE, the cause named, Yes / No with icon, tone and the pick", () => {
    const title = "Four observations will confirm or kill H1 and H2";
    const founder = {
      sessionId: SESSION_ID,
      label: `Decide: ${title}`,
      sessionTitle: `Decide: ${title}`,
      ask: {
        mode: "confirm",
        prompt: `Accept: ${title}?`,
        yes: { recommended: true, description: "Marks it accepted" },
        no: { description: "Marks it rejected" },
      },
      why: `${title}. Each one is dated.`,
      claimedDone: false,
      blockedReason: "decision",
      owedSince: "2026-10-18T09:00:00.000Z",
      askerName: null,
      askCause: { kind: "decision" as const },
    };
    const html = render(
      <AskAnswer
        slot={founder as never}
        live={founder as never}
        onSettled={() => {}}
        onClose={() => {}}
      />
    );
    const seenText = text(html);
    expect(seenText.split(title)).toHaveLength(2);
    expect(seenText).not.toMatch(
      /Decide:|Accept:|An agent|waiting on your answer|Question|Answer the agent/
    );
    expect(seenText).toContain("From a proposed decision");
    expect(seenText).toMatch(/Yes Recommended Marks it accepted/);
    expect(seenText).toContain("Marks it rejected");
    expect(seenText.match(/Add a note/g)).toHaveLength(1);
    const yes = buttons.find((b) => b.children === "Yes") as
      { color?: string; variant?: string; startContent?: unknown } | undefined;
    expect(yes).toMatchObject({ color: "success", variant: "solid" });
    expect(yes?.startContent).toBeTruthy();
  });

  it("answering sends the answer door Review uses, with the slot and the ask the reader saw", () => {
    seen.signals = [owedHere];
    render(<NeedsYouSection sessionId={SESSION_ID} />);
    const send = buttons.find((b) => b.children === "Send answer");
    expect(send?.onPress).toBeTypeOf("function");

    calls.length = 0;
    send!.onPress!();

    expect(calls).toEqual([
      [
        "focusSessions.answerOutput",
        {
          sessionId: SESSION_ID,
          expectedLabel: "Which day do we ship?",
          // The recommended option is the one picked until the reader moves.
          value: {
            type: "chip",
            chip: { label: "Ship Friday", value: "friday", recommended: true },
          },
          askFingerprint: askFingerprint(ASK as unknown as Ask),
        },
      ],
    ]);
  });

  it("draws nothing when the session owes the reader nothing", () => {
    seen.signals = [];
    expect(render(<NeedsYouSection sessionId={SESSION_ID} />)).toBe("");
    // A proposal waiting is not an ask: it has its own section.
    seen.signals = [cluster];
    expect(render(<NeedsYouSection sessionId={SESSION_ID} />)).toBe("");
  });

  it("a read that failed says so, with a retry — never drawn as nothing owed", () => {
    seen.signals = [];
    seen.failed.signals = "first-read";
    const seenText = text(render(<NeedsYouSection sessionId={SESSION_ID} />));
    expect(seenText).toContain("couldn’t be read");
    expect(seenText).toContain("Retry");
  });

  it("a poll that fails after a good read keeps the ask (and its answer) on screen", () => {
    seen.signals = [owedHere];
    seen.failed.signals = "poll";
    const seenText = text(render(<NeedsYouSection sessionId={SESSION_ID} />));
    expect(seenText).toContain("Which day do we ship?");
    expect(buttons.some((b) => b.children === "Send answer")).toBe(true);
    expect(seenText).toContain("couldn’t be read");
  });
});

describe("Proposed changes — this session's pending proposals", () => {
  it("lists only this session's pending proposals, each a door to its review", () => {
    seen.proposals = [proposalHere, proposalElsewhere];
    const html = render(<ProposedChangesSection sessionId={SESSION_ID} />);

    expect(calls).toContainEqual([
      "proposals.list",
      expect.objectContaining({ sessionId: SESSION_ID, status: "pending" }),
    ]);
    const seenText = text(html);
    expect(seenText).toContain("Proposed changes");
    expect(seenText).toContain("Draft the launch post");
    expect(seenText).toContain("Claude-code");
    expect(html).toContain(`href="/proposal/${proposalHere.id}"`);
    expect(seenText).not.toContain("Another session's task");
    expect(html).not.toContain(proposalElsewhere.id);
    // Decided on its review page, never from the row.
    expect(seenText).not.toMatch(/\bApprove\b/);
  });

  it('names an entity proposal by its kind, not the generic "Entity"', () => {
    seen.proposals = [
      {
        ...proposalHere,
        targetType: "entity",
        data: {},
        request: {
          data: { profileSlug: "task", title: "Draft the launch post" },
        },
      },
    ];
    const seenText = text(
      render(<ProposedChangesSection sessionId={SESSION_ID} />)
    );
    expect(seenText).toContain("Task · Claude-code");
    expect(seenText).not.toContain("Entity");
  });

  it("draws nothing when the session proposed nothing", () => {
    seen.proposals = [];
    expect(render(<ProposedChangesSection sessionId={SESSION_ID} />)).toBe("");
  });

  it("a read that failed says so — never drawn as nothing proposed", () => {
    seen.proposals = [];
    seen.failed.proposals = "first-read";
    const seenText = text(
      render(<ProposedChangesSection sessionId={SESSION_ID} />)
    );
    expect(seenText).toContain("couldn’t be read");
  });

  it("a poll that fails after a good read keeps the proposals listed", () => {
    seen.proposals = [proposalHere];
    seen.failed.proposals = "poll";
    const seenText = text(
      render(<ProposedChangesSection sessionId={SESSION_ID} />)
    );
    expect(seenText).toContain("Draft the launch post");
    expect(seenText).toContain("couldn’t be read");
  });
});

/**
 * Layout A (founder, 2026-10-28): an escalated criterion is graded under the
 * criterion in the session's rail, through the same answer card, and Needs
 * you then leaves it out — the reader meets each grade once.
 */
describe("A criterion's grade — once, in the rail", () => {
  it("finds the slot that grades each criterion, only when its ask IS the grade", () => {
    const grades = criterionGradeSignals(
      [owedHere, criterionSlot, criterionSlotOpenAsk, owedElsewhere] as never,
      SESSION_ID
    );
    expect([...grades]).toEqual([["relay-approve", "owed:criterion"]]);
  });

  it("Needs you leaves out a criterion the rail grades, and keeps every other ask", () => {
    seen.signals = [owedHere, criterionSlot];
    const both = text(render(<NeedsYouSection sessionId={SESSION_ID} />));
    expect(both).toContain("same turn-on doors");
    expect(both).toContain("Which day do we ship?");

    const railed = text(
      render(
        <NeedsYouSection
          sessionId={SESSION_ID}
          gradedInRail={new Set(["relay-approve"])}
        />
      )
    );
    expect(railed).not.toContain("same turn-on doors");
    expect(railed).toContain("Which day do we ship?");
    expect(railed).toContain("1 waiting on you");
  });

  it("with only railed grades left, Needs you draws nothing", () => {
    seen.signals = [criterionSlot];
    expect(
      render(
        <NeedsYouSection
          sessionId={SESSION_ID}
          gradedInRail={new Set(["relay-approve"])}
        />
      )
    ).toBe("");
  });

  it("the rail draws the grade with Review's answer card: Pass, Fail, Send answer", () => {
    seen.signals = [owedHere, criterionSlot];
    const html = render(
      <CriterionGrade sessionId={SESSION_ID} criterionKey="relay-approve" />
    );
    const seenText = text(html);
    expect(seenText).toContain("Pass");
    expect(seenText).toContain("Fail");
    expect(buttons.some((b) => b.children === "Send answer")).toBe(true);
    // Under its own statement: the why is not said a second time.
    expect(seenText).not.toContain("Checked 2 times");
    // It reads Needs you's own query, never a second one.
    expect(calls).toContainEqual([
      "signals.list",
      expect.objectContaining({ lens: "needs-you", sessionId: SESSION_ID }),
    ]);
  });

  it("draws nothing for a criterion with no grade waiting on the person", () => {
    seen.signals = [owedHere, criterionSlot, criterionSlotOpenAsk];
    expect(
      render(
        <CriterionGrade sessionId={SESSION_ID} criterionKey="grade-in-place" />
      )
    ).toBe("");
    expect(
      render(
        <CriterionGrade
          sessionId={SESSION_ID}
          criterionKey="activate-draft-rule"
        />
      )
    ).toBe("");
  });
});
