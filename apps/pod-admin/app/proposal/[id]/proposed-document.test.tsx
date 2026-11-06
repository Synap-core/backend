import { createElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../(admin)/components/side-nav-role", () => ({
  useConsoleRole: () => state.role,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/proposal",
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/* The queue behind this proposal: one other proposal waits (Review's row). */
vi.mock("../../(admin)/review/_lib/review-rows", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../(admin)/review/_lib/review-rows")
  >()),
  reviewRows: () => [
    {
      id: "next-row",
      title: "Edit section in Document Roadmap",
      detail: {
        kind: "proposal",
        proposalId: "99999999-9999-4999-8999-999999999999",
      },
    },
  ],
}));

/* next/dynamic needs the Next runtime: draw the real markdown view directly. */
vi.mock("../../_lib/object/content/content-block", async () => {
  const { default: MarkdownView } =
    await import("../../_lib/object/content/markdown-view");
  return {
    ContentBody: ({ prepared }: { prepared: { text: string } }) => (
      <MarkdownView source={prepared.text} />
    ),
  };
});

const { state, presses, approveCalls, ids } = vi.hoisted(() => ({
  state: {
    proposal: null as unknown,
    defs: [] as unknown[],
    role: "admin" as "admin" | "member",
  },
  presses: new Map<string, () => void>(),
  approveCalls: [] as unknown[],
  ids: {
    PROPOSAL: "11111111-1111-4111-8111-111111111111",
    NEW: "22222222-2222-4222-8222-222222222222",
    NEXT: "99999999-9999-4999-8999-999999999999",
    TWIN: "33333333-3333-4333-8333-333333333333",
    TWIN_2: "44444444-4444-4444-8444-444444444444",
    AGENT: "55555555-5555-4555-8555-555555555555",
  },
}));

/* Record each button's press under a stable key — a verb button's
   `data-verb`, else its text — and render the real HeroUI button. */
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  const Button = (props: Record<string, unknown>) => {
    const key =
      (props["data-verb"] as string | undefined) ??
      (typeof props.children === "string" ? props.children : undefined);
    if (key && typeof props.onPress === "function") {
      presses.set(key, props.onPress as () => void);
    }
    return createElement(real.Button, props as never);
  };
  return { ...real, Button };
});

vi.mock("../../../lib/trpc", async () => ({
  trpc: {
    presence: (
      await import("../../_lib/presence/__tests__/trpc-double")
    ).presenceTrpcDouble(),
    useUtils: () => ({}),
    useQueries: () => [],
    proposals: {
      get: {
        useQuery: () => ({
          data: state.proposal,
          isLoading: false,
          error: null,
          refetch() {},
        }),
      },
      source: {
        useQuery: () => ({
          data: {
            targets: [{ kind: "agent", id: ids.AGENT, label: "Claude-code" }],
          },
        }),
      },
      approve: {
        useMutation: () => ({
          mutate: (input: unknown) => approveCalls.push(input),
          mutateAsync: async (input: unknown) => approveCalls.push(input),
          isPending: false,
        }),
      },
      reject: { useMutation: () => ({ mutate() {}, isPending: false }) },
      // Nothing is applying in the background (`approval-progress`).
      approvalProgress: {
        useQuery: () => ({
          data: null,
          isError: false,
          isFetching: false,
          refetch() {},
        }),
      },
    },
    profiles: {
      get: {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => ({
          data: opts?.enabled ? { effectiveProperties: state.defs } : undefined,
        }),
      },
    },
    entities: { get: { useQuery: () => ({ data: undefined }) } },
    // A decided (or expired) proposal's page offers the next door from
    // Review's rows: nothing waits here.
    signals: {
      list: {
        useQuery: () => ({
          data: { signals: [{ id: "next-row" }] },
          isLoading: false,
          error: null,
        }),
      },
    },
    workspaces: { get: { useQuery: () => ({ data: undefined }) } },
    governanceRules: {
      create: { useMutation: () => ({ mutate() {}, isPending: false }) },
      setActionMode: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
  },
}));

import { ProposalReview } from "./ProposalReview";
import { ProposedDocumentBody } from "./ProposedDocumentBody";
import { READS_WIDE_ATTR } from "../../_lib/receiver-shell";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** A markdown body: a heading, a list, then ~5,000 characters of paragraphs. */
const TAIL_MARKER = "THE-LAST-SENTENCE-OF-THE-DOCUMENT";
function longBody(): string {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i + 1}: ${"lorem ipsum dolor ".repeat(7).trim()}.`
  );
  return [
    "# Launch plan",
    "- first point\n- second point",
    ...paragraphs,
    `${TAIL_MARKER}.`,
  ].join("\n\n");
}

function documentCreate(status: string, content: string) {
  const data = { id: ids.NEW, title: "Launch plan", type: "markdown", content };
  return {
    id: ids.PROPOSAL,
    workspaceId: null,
    targetType: "document",
    targetId: ids.NEW,
    targetName: null,
    proposalType: "create",
    status,
    agentUserId: ids.AGENT,
    governanceReason: null,
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    authorName: "Claude-code",
    agentActorName: "Claude-code",
    principal: { kind: "delegated", name: "Grace Hopper" },
    revertable: true,
    data: { data, changeType: "create", targetType: "document" },
    request: {
      targetType: "document",
      targetId: ids.NEW,
      changeType: "create",
      data,
    },
    review: {
      changes: [
        {
          path: "title",
          label: "Title",
          operation: "create",
          after: "Launch plan",
        },
        {
          path: "content",
          label: "Content",
          operation: "create",
          after: content,
        },
      ],
    },
  };
}

const render = () =>
  renderToStaticMarkup(
    <ProposalReview proposalId={ids.PROPOSAL} identity="Grace Hopper" />
  );

beforeEach(() => {
  presses.clear();
  approveCalls.length = 0;
  state.defs = [];
  state.role = "admin";
});

describe("a Create document request, pending", () => {
  it("draws the title, a Document mark and the body as markdown, not raw text", () => {
    const content = longBody();
    expect(content.length).toBeGreaterThan(5000);
    state.proposal = documentCreate("pending", content);
    const html = render();
    const card = html.slice(html.indexOf("data-proposed-record"));
    expect(card).toContain("Launch plan");
    expect(card).toContain("data-record-kind");
    // The preview is rendered markdown: a heading element and list items.
    const body = card.slice(
      card.indexOf('data-proposed-document-body="preview"')
    );
    expect(body).toMatch(/<h\d[^>]*>Launch plan<\/h\d>/);
    expect(body).toMatch(/<li[^>]*>(<p>)?first point/);
    expect(body).not.toContain("# Launch plan");
    // Only the start is drawn; the rest is one press away.
    expect(text(card)).not.toContain(TAIL_MARKER);
    expect(text(card)).toContain("Read the whole document");
    expect(presses.has("Read the whole document")).toBe(true);
  });

  it("a short document is drawn whole and offers no extra control", () => {
    state.proposal = documentCreate("pending", "# Note\n\nTwo lines.\n\nDone.");
    const out = text(render());
    expect(out).toContain("Done.");
    expect(out).not.toContain("Read the whole document");
  });

  /* Proposal 70fc80c4 (founder, 2026-11-03): the review of a document opens
     at the document page's width. The receiver card widens on this mark. */
  it("reads at the document's width, long or short", () => {
    state.proposal = documentCreate("pending", longBody());
    expect(render()).toContain(`${READS_WIDE_ATTR}=""`);
    state.proposal = documentCreate("pending", "# Note\n\nTwo lines.");
    expect(render()).toContain(`${READS_WIDE_ATTR}=""`);
  });
});

describe("ProposedDocumentBody — the whole document is readable", () => {
  it("opened, a 5,000+ character body is drawn to its last sentence, as markdown", () => {
    const content = longBody();
    const out = renderToStaticMarkup(
      <ProposedDocumentBody content={content} defaultOpen />
    );
    expect(out).toContain('data-proposed-document-body="whole"');
    expect(text(out)).toContain(TAIL_MARKER);
    expect(text(out)).toContain("Paragraph 40:");
    expect(out).toMatch(/<h\d[^>]*>Launch plan<\/h\d>/);
    expect(text(out)).toContain("Show less");
  });
});

describe("an approved Create document", () => {
  it("names what was created and links to the document page", () => {
    state.proposal = documentCreate("approved", "# Note\n\nBody.");
    const html = render();
    const door = html.slice(html.indexOf("data-created-object"));
    expect(text(door)).toMatch(/Created · Launch plan/);
    expect(door).toContain(`href="/open/document/${ids.NEW}"`);
    expect(text(door)).toContain("Open document");
  });

  it("labels the next proposal as the queue's, apart from this one", () => {
    state.proposal = documentCreate("approved", "# Note\n\nBody.");
    const html = render();
    const queue = html.slice(html.indexOf("data-review-queue"));
    expect(text(queue)).toContain("Next in your queue");
    expect(queue).toContain(`href="/proposal/${ids.NEXT}"`);
    expect(text(queue)).toContain("Edit section in Document Roadmap");
    expect(text(html)).not.toContain("Next: ");
    // The created document's door comes first, the queue after it.
    expect(html.indexOf("data-created-object")).toBeLessThan(
      html.indexOf("data-review-queue")
    );
  });

  it("a pending one has no Open document yet", () => {
    state.proposal = documentCreate("pending", "# Note\n\nBody.");
    expect(render()).not.toContain("data-created-object");
  });
});
