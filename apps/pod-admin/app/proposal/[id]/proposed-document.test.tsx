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

const { state, presses, approveCalls, docQueries, ids } = vi.hoisted(() => ({
  state: {
    proposal: null as unknown,
    defs: [] as unknown[],
    role: "admin" as "admin" | "member",
    /** What `documents.get` answers (the live document a page update reads). */
    document: (() => ({
      data: undefined,
      isLoading: false,
      error: null,
    })) as () => unknown,
  },
  docQueries: [] as { input: unknown; enabled: boolean | undefined }[],
  presses: new Map<string, () => void>(),
  approveCalls: [] as unknown[],
  ids: {
    PROPOSAL: "11111111-1111-4111-8111-111111111111",
    NEW: "22222222-2222-4222-8222-222222222222",
    NEXT: "99999999-9999-4999-8999-999999999999",
    TWIN: "33333333-3333-4333-8333-333333333333",
    TWIN_2: "44444444-4444-4444-8444-444444444444",
    AGENT: "55555555-5555-4555-8555-555555555555",
    DOC: "66666666-6666-4666-8666-666666666666",
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
    documents: {
      get: {
        useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
          docQueries.push({ input, enabled: opts?.enabled });
          return opts?.enabled === false
            ? { data: undefined, isLoading: false, error: null }
            : state.document();
        },
      },
    },
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
  docQueries.length = 0;
  state.defs = [];
  state.role = "admin";
  state.document = () => ({ data: undefined, isLoading: false, error: null });
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

/* ── A document UPDATE: the pages, and the way into the object ────────────────
   Shaped like the real proposal (19780cd3, 14 Nov 2026): the op replaces the
   whole body with the COMPLETE page, while `preview` holds cut regions that
   begin inside the stylesheet (the head is missing), which is what the old
   text reading drew as struck-through source. */
const HEAD = "<!doctype html><html><head><style>:root{--a:1}</style></head>";
const PAGE_BEFORE = `${HEAD}<body><h1>OLD-HEADLINE</h1><p>shared</p></body></html>`;
const PAGE_AFTER = `${HEAD}<body><h1>NEW-HEADLINE</h1><p>shared</p></body></html>`;
const cut = (page: string) => page.slice(HEAD.length - 1);

function documentUpdate(
  status: string,
  over: {
    ops?: unknown[];
    stamped?: boolean;
    targetType?: string;
    action?: string;
  } = {}
) {
  const data = {
    id: ids.DOC,
    title: "Lean report",
    documentId: ids.DOC,
    ops: over.ops ?? [{ op: "replace_all", content: PAGE_AFTER }],
    preview: [
      {
        sectionId: null,
        title: null,
        before: cut(PAGE_BEFORE),
        after: cut(PAGE_AFTER),
      },
    ],
    baseVersion: 1,
  };
  const action = over.action ?? "update";
  const targetType = over.targetType ?? "document";
  return {
    id: ids.PROPOSAL,
    workspaceId: null,
    targetType,
    targetId: ids.DOC,
    targetName: "Lean report",
    proposalType: action,
    status,
    agentUserId: ids.AGENT,
    governanceReason: null,
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    authorName: "Claude-code",
    agentActorName: "Claude-code",
    principal: { kind: "delegated", name: "Grace Hopper" },
    revertable: true,
    data: {
      data,
      changeType: action,
      targetType,
      ...(over.stamped
        ? {
            materialized: {
              documentEdit: {
                documentId: ids.DOC,
                granularity: "body",
                changes: [
                  {
                    before: PAGE_BEFORE,
                    after: PAGE_AFTER,
                    title: null,
                    sectionId: null,
                  },
                ],
              },
            },
          }
        : {}),
    },
    request: { targetType, targetId: ids.DOC, changeType: action, data },
    review: { changes: [{ path: "ops", label: "Ops", operation: "update" }] },
  };
}

/** The live document as the viewer reads it. */
const liveDocument = (type: string, content: string) => () => ({
  data: { document: { type, workspaceId: null }, content },
  isLoading: false,
  error: null,
});

const iframes = (html: string) => html.match(/<iframe\b[^>]*>/g) ?? [];

describe("an Update document request whose document is an HTML page", () => {
  it("draws the new page, whole, not its struck-through source", () => {
    state.proposal = documentUpdate("pending");
    state.document = liveDocument("html", PAGE_BEFORE);
    const html = render();
    const panel = html.slice(html.indexOf("data-html-update"));
    expect(iframes(panel)).toHaveLength(1);
    expect(iframes(panel)[0]).toContain('sandbox="allow-scripts"');
    // The NEW page, and the head the cut preview never had: it is the whole page.
    expect(panel).toContain("NEW-HEADLINE");
    expect(panel).toContain(":root{--a:1}");
    expect(panel).not.toContain("OLD-HEADLINE");
    // The old reading is not drawn for an HTML page.
    expect(html).not.toContain("data-text-diff");
  });

  it("offers Result, Before | After and Lines, opening on the result", () => {
    state.proposal = documentUpdate("pending");
    state.document = liveDocument("html", PAGE_BEFORE);
    const out = text(render());
    expect(out).toContain("Result");
    expect(out).toContain("Before | After");
    expect(out).toContain("Lines");
  });

  it("reads the document by its id, in its raw form", () => {
    state.proposal = documentUpdate("pending");
    state.document = liveDocument("html", PAGE_BEFORE);
    render();
    expect(docQueries).toContainEqual({
      input: { documentId: ids.DOC, format: "raw" },
      enabled: true,
    });
  });

  it("an approved change with a stamped edit knows the page as it was", () => {
    state.proposal = documentUpdate("approved", { stamped: true });
    // The document is now the AFTER: it must not be taken for the "before".
    state.document = liveDocument("html", PAGE_AFTER);
    const out = text(render());
    expect(out).toContain("Before | After");
    expect(out).not.toContain("only the result is shown");
  });

  it("an approved change with nothing stamped shows the result and says why not more", () => {
    state.proposal = documentUpdate("approved");
    state.document = liveDocument("html", PAGE_AFTER);
    const html = render();
    const out = text(html);
    expect(out).toContain("only the result is shown");
    expect(out).not.toContain("Before | After");
    expect(iframes(html.slice(html.indexOf("data-html-update")))).toHaveLength(
      1
    );
  });
});

describe("an Update document request that is not an HTML page", () => {
  it("a Markdown document keeps its text reading and draws no frame", () => {
    state.proposal = documentUpdate("pending");
    state.document = liveDocument("markdown", "# Old");
    const html = render();
    expect(html).toContain("data-text-diff");
    expect(html).not.toContain("data-html-update");
    expect(iframes(html)).toHaveLength(0);
  });

  it("a patch (not a whole-body replacement) is never drawn as a page, and reads nothing", () => {
    state.proposal = documentUpdate("pending", {
      ops: [{ op: "replace_section", sectionId: "s1", content: "<p>x</p>" }],
    });
    state.document = liveDocument("html", PAGE_BEFORE);
    const html = render();
    expect(html).toContain("data-text-diff");
    expect(html).not.toContain("data-html-update");
    expect(docQueries.every((q) => q.enabled === false)).toBe(true);
  });

  it("while the document is read, says so and draws neither reading", () => {
    state.proposal = documentUpdate("pending");
    state.document = () => ({ data: undefined, isLoading: true, error: null });
    const html = render();
    expect(text(html)).toContain("Reading the page…");
    expect(html).not.toContain("data-text-diff");
    expect(iframes(html)).toHaveLength(0);
  });

  it("a failed read is said, and the change stays readable as text", () => {
    state.proposal = documentUpdate("pending");
    state.document = () => ({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    });
    const html = render();
    expect(text(html)).toContain("couldn’t be read");
    expect(html).toContain("data-text-diff");
    expect(iframes(html)).toHaveLength(0);
    expect(html).not.toContain("boom");
  });
});

describe("the door to the object an update changes", () => {
  it("a pending update names the document and links to its page", () => {
    state.proposal = documentUpdate("pending");
    state.document = liveDocument("html", PAGE_BEFORE);
    const html = render();
    const door = html.slice(html.indexOf("data-updated-object"));
    expect(text(door)).toMatch(/^[^<]*>?\s*Update · Lean report/);
    expect(door).toContain(`href="/open/document/${ids.DOC}"`);
    expect(text(door)).toContain("Open document");
  });

  it("an approved one says Updated, and still opens the document", () => {
    state.proposal = documentUpdate("approved", { stamped: true });
    state.document = liveDocument("html", PAGE_AFTER);
    const door = render();
    const at = door.slice(door.indexOf("data-updated-object"));
    expect(text(at)).toContain("Updated · Lean report");
    expect(at).toContain(`href="/open/document/${ids.DOC}"`);
  });

  it("comes before the change it is about", () => {
    state.proposal = documentUpdate("pending");
    state.document = liveDocument("html", PAGE_BEFORE);
    const html = render();
    expect(html.indexOf("data-updated-object")).toBeLessThan(
      html.indexOf("data-html-update")
    );
  });

  it("a create has no object yet: no update door", () => {
    state.proposal = documentCreate("pending", "# Note\n\nBody.");
    expect(render()).not.toContain("data-updated-object");
  });

  it("a delete names no object to open", () => {
    state.proposal = documentUpdate("pending", { action: "delete" });
    expect(render()).not.toContain("data-updated-object");
  });
});
