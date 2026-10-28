/**
 * Review grouped by the decision each item asks (founder B-1, 27 Oct 2026),
 * RENDERED (react-dom/server; pod-admin's vitest runs in node). Asserts what
 * the reader sees: the packages in their fixed order, each in its own layout
 * with its one action, and the Work grouping naming each row's package.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewLayout } from "@synap-core/types/proposals/review-package";
import { defaultReviewLayout } from "@synap-core/types/proposals/review-package";
import { ReviewGroups, type ReviewGroupActions } from "./review-groups";
import {
  reviewRows,
  type ProposalFacts,
  type ReviewSignal,
} from "./review-rows";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

const AGENT = { kind: "agent" as const, id: "agent-1", label: "Claude Code" };

function cluster(
  id: string,
  session: string,
  over: Partial<ReviewSignal> = {}
): ReviewSignal {
  return {
    id,
    kind: "proposal-cluster",
    title: `Title ${id}`,
    count: 1,
    groupKey: `session:${session}`,
    sessionTitle: `Session ${session}`,
    ageBucket: "recent",
    repeatCount: 1,
    occurredAt: "2026-10-27T10:00:00.000Z",
    category: "governance",
    class: "objectWork",
    target: { kind: "proposal", id: `${id}-p` },
    proposalIds: [`${id}-p`],
    by: AGENT,
    ...over,
  };
}

const facts = new Map<string, ProposalFacts>(
  (
    [
      ["book-1", "update", "focus_session"],
      ["book-2", "update", "focus_session"],
      ["hand-1", "assign_agent", "focus_session"],
      ["hand-2", "assign_agent", "focus_session"],
      ["know-1", "import.graph", "entity"],
      ["rule-1", "update", "skill"],
    ] as const
  ).map(([id, proposalType, targetType]) => [
    `${id}-p`,
    {
      id: `${id}-p`,
      proposalType,
      targetType,
      viewerCanReview: true,
    },
  ])
);

const rows = reviewRows(
  [
    cluster("book-1", "s1"),
    cluster("hand-1", "s2"),
    cluster("know-1", "s1"),
    cluster("book-2", "s2"),
    cluster("rule-1", "s1"),
    cluster("hand-2", "s3"),
  ],
  facts
);

const actions: ReviewGroupActions = {
  renderRow: (row, opts) => (
    <div key={row.key} data-test-row={row.key}>
      {opts?.showPackage ? `[${row.package}] ` : ""}
      {row.title}
    </div>
  ),
  open: () => {},
  keep: () => {},
  busy: false,
  renderInline: (row) => <div data-test-inline={row.key} />,
  alwaysForAgent: () => {},
};

function render(
  groupBy: "package" | "work" | "agent" | "time",
  layoutOf: (
    pkg: Parameters<typeof defaultReviewLayout>[0]
  ) => ReviewLayout = defaultReviewLayout
): string {
  return renderToStaticMarkup(
    <ReviewGroups
      rows={rows}
      groupBy={groupBy}
      layoutOf={layoutOf}
      onLayout={() => {}}
      actions={actions}
    />
  );
}

describe("Group by Package", () => {
  const html = render("package");

  it("draws the packages in the FIXED order, stakes first", () => {
    const order = [
      "How things work",
      "Hand-offs",
      "Knowledge",
      "Bookkeeping",
    ].map((name) => html.indexOf(`>${name}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No empty package is drawn.
    expect(html).not.toContain(">Questions<");
  });

  it("each package says how many wait", () => {
    expect(html).toContain("2 waiting");
  });

  it("How things work reads the picked change beside its list", () => {
    expect(html).toContain('data-test-inline="rule-1"');
  });

  it("Hand-offs: one block per agent, Allow all and Always for this agent", () => {
    expect(html).toContain("Claude Code takes 2");
    expect(html).toContain("Allow all 2");
    expect(html).toContain("Always for this agent");
    expect(html).toContain("Session s2");
    expect(html).toContain("Session s3");
  });

  it("Knowledge is a gallery and Bookkeeping folds per session, each with Keep all", () => {
    expect(html).toContain("Title know-1");
    expect(html).toContain("Keep all 2");
    expect(html).toContain("See them");
    // Folded: the bookkeeping rows themselves are not drawn until opened.
    expect(html).not.toContain('data-test-row="book-1"');
  });

  it("a package switched to List draws its rows", () => {
    const list = render("package", () => "list");
    expect(list).toContain('data-test-row="book-1"');
    expect(list).toContain('data-test-row="know-1"');
  });
});

describe("Group by Work", () => {
  it("each session holds its rows, each naming its package", () => {
    const html = render("work");
    expect(html).toContain(">Session s1<");
    expect(html).toContain("[bookkeeping] Title book-1");
    expect(html).toContain("[knowledge] Title know-1");
    expect(html).toContain("Open session");
  });
});
