/**
 * An agent's held-writes pack (`agent/held_writes`), as the founder opened it
 * (2026-10-27, approved, ten writes): RENDERED (react-dom/server) through the
 * real page, from the wire shape `proposals.get` returns — the writes and
 * their outcomes at the top of `data`, keyed by uuid refs, and the pod's
 * field diff in `review.changes` (which is what the page used to draw as an
 * "Untitled" record listing Day / Deferred writes / Deferred outcomes).
 *
 * Covers the change section and the heading; the collapsed Advanced panel
 * (ids + the raw request, on purpose) is outside the slice read here.
 */
import { createElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/proposal",
  useRouter: () => ({ replace() {}, push() {} }),
}));

const { state, presses, ids } = vi.hoisted(() => ({
  state: { proposal: null as unknown },
  presses: new Map<string, () => void>(),
  ids: {
    PROPOSAL: "11111111-1111-4111-8111-111111111111",
    AGENT: "55555555-5555-4555-8555-555555555555",
    TASK: "22222222-2222-4222-8222-222222222222",
    OTHER: "33333333-3333-4333-8333-333333333333",
    SESSION: "44444444-4444-4444-8444-444444444444",
  },
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  const Button = (props: Record<string, unknown>) => {
    const key = typeof props.children === "string" ? props.children : null;
    if (key && typeof props.onPress === "function") {
      presses.set(key, props.onPress as () => void);
    }
    return createElement(real.Button, props as never);
  };
  return { ...real, Button };
});

vi.mock("../../../lib/trpc", () => ({
  trpc: {
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
        useMutation: () => ({ mutate() {}, isPending: false }),
      },
      reject: { useMutation: () => ({ mutate() {}, isPending: false }) },
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
      get: { useQuery: () => ({ data: undefined }) },
    },
    entities: { get: { useQuery: () => ({ data: undefined }) } },
    signals: {
      list: {
        useQuery: () => ({ data: undefined, isLoading: true, error: null }),
      },
    },
    workspaces: { get: { useQuery: () => ({ data: undefined }) } },
    governanceRules: {
      create: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
  },
}));

import { ProposalReview } from "./ProposalReview";

/** A uuid ref, as the gate mints them (`randomUUID`). */
const ref = (n: number) =>
  `0cf10d69-c16c-499a-8a1b-${String(n).padStart(12, "0")}`;

const write = (n: number, over: Record<string, unknown> = {}) => ({
  ref: ref(n),
  subjectType: "entity",
  action: "create",
  data: { profileSlug: "task", title: `Task ${n}` },
  sessionId: null,
  agentUserId: ids.AGENT,
  userId: "66666666-6666-4666-8666-666666666666",
  at: "2026-10-27T09:00:00.000Z",
  fingerprint: `fp-${n}`,
  ...over,
});

function heldWrites(n: number, status = "approved") {
  const deferredWrites: unknown[] = [
    write(1, {
      data: { id: ids.TASK, profileSlug: "task", title: "Ship v2" },
    }),
    write(2, { data: { profileSlug: "note", title: "Launch notes" } }),
    write(3, {
      subjectType: "focus_session",
      data: { goal: "Draft the launch post" },
    }),
    ...Array.from({ length: n - 3 }, (_, i) => write(i + 4)),
  ];
  const at = "2026-10-27T10:00:00.000Z";
  const deferredOutcomes =
    status === "pending"
      ? undefined
      : {
          [ref(1)]: { outcome: "applied", id: ids.TASK, at },
          [ref(2)]: { outcome: "proposed", proposalId: ids.OTHER, at },
          [ref(3)]: {
            outcome: "refused",
            reason: "The project is archived.",
            at,
          },
        };
  const data = {
    day: "2026-10-27",
    agentUserId: ids.AGENT,
    deferredWrites: [...deferredWrites, { ref: "broken" }],
    source: "agent",
    ...(deferredOutcomes ? { deferredOutcomes } : {}),
  };
  return {
    id: ids.PROPOSAL,
    workspaceId: null,
    targetType: "agent",
    targetId: ids.AGENT,
    targetName: undefined,
    proposalType: "held_writes",
    status,
    agentUserId: ids.AGENT,
    governanceReason: "DAILY_WRITE_CEILING",
    createdAt: new Date(Date.now() - 3_600_000),
    authorName: "Claude-code",
    agentActorName: "Claude-code",
    principal: { kind: "delegated", name: "Grace Hopper" },
    revertable: false,
    data,
    request: { targetType: "agent", targetId: ids.AGENT, data },
    review: {
      reasoning: undefined,
      // The pod's field diff of the flat payload: what drew "Untitled".
      changes: [
        { path: "day", label: "Day", operation: "create", after: data.day },
        {
          path: "deferredWrites",
          label: "Deferred writes",
          operation: "create",
          after: data.deferredWrites,
        },
        ...(deferredOutcomes
          ? [
              {
                path: "deferredOutcomes",
                label: "Deferred outcomes",
                operation: "create",
                after: deferredOutcomes,
              },
            ]
          : []),
      ],
    },
  };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const render = () =>
  renderToStaticMarkup(
    <ProposalReview proposalId={ids.PROPOSAL} identity="Grace Hopper" />
  );

/** The page above the decision bar: the heading, who asked, the change. */
const changeSection = (html: string) =>
  html.slice(0, html.indexOf("data-review-decision"));

const UUID = /[0-9a-f]{8}[- ][0-9a-f]{4}[- ][0-9a-f]{4}[- ][0-9a-f]{4}/i;

beforeEach(() => {
  presses.clear();
});

describe("a held-writes pack", () => {
  it("heads with the agent's name, never 'Held writes Agent'", () => {
    state.proposal = heldWrites(10);
    const seen = text(render());
    expect(seen).toContain(
      "Writes held for review: Claude-code, 2026-10-27, 11 items"
    );
    expect(seen).not.toMatch(/Held writes/);
  });

  it("lists each write by what it does — no Untitled card, no payload fields, no ids", () => {
    state.proposal = heldWrites(10);
    const html = changeSection(render());
    const seen = text(html);
    expect(seen).toContain('Create Task "Ship v2"');
    expect(seen).toContain('Create Note "Launch notes"');
    expect(seen).toContain('Create Session "Draft the launch post"');
    expect(seen).not.toContain("Untitled");
    expect(seen).not.toMatch(/Deferred outcomes|Deferred writes|\bDay\b/i);
    expect(seen).not.toMatch(UUID);
    expect(html).not.toContain("data-proposed-record");
  });

  it("each outcome is a mark; applied and proposed rows are doors", () => {
    state.proposal = heldWrites(10);
    const html = changeSection(render());
    const row = (n: number) => {
      const start = html.indexOf(`data-deferred-write="${ref(n)}"`);
      return html.slice(start, html.indexOf("</li>", start));
    };
    expect(text(row(1))).toContain("Applied");
    expect(row(1)).toContain(`href="/open/entity/${ids.TASK}"`);
    expect(text(row(2))).toContain("Proposed");
    expect(row(2)).toContain(`href="/proposal/${ids.OTHER}"`);
    expect(text(row(3))).toMatch(/Refused.*The project is archived\./);
    expect(row(3)).not.toContain("href=");
  });

  it("is capped, then 'Show all N writes'; an unreadable entry is said", () => {
    state.proposal = heldWrites(10);
    const html = changeSection(render());
    expect(html.match(/data-deferred-write=/g)).toHaveLength(8);
    const seen = text(html);
    expect(seen).toContain("11 writes");
    expect(presses.has("Show all 10 writes")).toBe(true);
    expect(seen).toMatch(/1 write could not be read/);
  });

  it("while pending, rows carry no outcome mark", () => {
    state.proposal = heldWrites(4, "pending");
    const seen = text(changeSection(render()));
    expect(seen).toContain('Create Task "Ship v2"');
    expect(seen).not.toMatch(/Applied|Refused/);
  });
});
