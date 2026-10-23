/**
 * The proposal review as the founder dogfooded it (2026-10-23, an agent's
 * "Create <person>" the pod's duplicate door had matched to an existing
 * person), RENDERED (react-dom/server; pod-admin's vitest runs in node) and
 * DRIVEN: every button's `onPress` is recorded as it renders, then pressed, and
 * the `proposals.approve` input that reaches the tRPC client is asserted —
 * the real path from the verb on screen to the pod.
 *
 * What v1 got wrong, each pinned here:
 *  - the twin the pod found was never shown, and the plain Approve kept both;
 *  - the change was a column of chipped values, the record's name a "Title"
 *    row, and `ResolvedWorkspaceId: empty` a fact;
 *  - "Always asks a person" + a paragraph; "Can be undone" + a paragraph;
 *  - the agent's words unlabelled.
 *
 * Fixtures are the wire shape `proposals.get` returns (`data.duplicateCheck`
 * at the top beside the request envelope; `review.changes` as
 * `routers/proposals/changes.ts` built it BEFORE it stripped
 * `resolvedWorkspaceId`, so an older pod's row is covered too), invented names.
 */
import { createElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";

vi.mock("next/navigation", () => ({
  usePathname: () => "/proposal",
  useRouter: () => ({ replace() {}, push() {} }),
}));

const { state, presses, approveCalls, ids } = vi.hoisted(() => ({
  state: { proposal: null as unknown, defs: [] as unknown[] },
  presses: new Map<string, () => void>(),
  approveCalls: [] as unknown[],
  ids: {
    PROPOSAL: "11111111-1111-4111-8111-111111111111",
    NEW: "22222222-2222-4222-8222-222222222222",
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
        useMutation: () => ({
          mutate: (input: unknown) => approveCalls.push(input),
          mutateAsync: async (input: unknown) => approveCalls.push(input),
          isPending: false,
        }),
      },
      reject: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
    profiles: {
      get: {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => ({
          data: opts?.enabled ? { effectiveProperties: state.defs } : undefined,
        }),
      },
    },
    entities: { get: { useQuery: () => ({ data: undefined }) } },
    workspaces: { get: { useQuery: () => ({ data: undefined }) } },
    governanceRules: {
      create: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
  },
}));

import { ProposalReview } from "./ProposalReview";

const TWIN = {
  ref: "record",
  id: ids.TWIN,
  kind: "person",
  title: "Ada Lovelace",
  why: "same_name",
};

/** The founder's row, names invented: a person create with a same-name twin. */
function personCreate(duplicateCheck: unknown) {
  const record = {
    id: ids.NEW,
    title: "Ada Lovelace",
    global: false,
    properties: { role: "CTO", started: "2026-10-01" },
    profileSlug: "person",
    resolvedWorkspaceId: null,
  };
  return {
    id: ids.PROPOSAL,
    workspaceId: null,
    targetType: "entity",
    targetId: ids.NEW,
    targetName: "Ada Lovelace",
    proposalType: "create",
    status: "pending",
    agentUserId: ids.AGENT,
    governanceReason: duplicateCheck ? "POSSIBLE_DUPLICATE" : null,
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    authorName: "Claude-code",
    agentActorName: "Claude-code",
    principal: { kind: "delegated", name: "Grace Hopper" },
    revertable: true,
    data: {
      data: record,
      changeType: "create",
      targetType: "entity",
      reasoning: "Same kind and name as a person you have; check the twin.",
      ...(duplicateCheck ? { duplicateCheck } : {}),
    },
    request: {
      targetType: "entity",
      targetId: ids.NEW,
      changeType: "create",
      data: record,
      reasoning: "Same kind and name as a person you have; check the twin.",
    },
    review: {
      reasoning: "Same kind and name as a person you have; check the twin.",
      changes: [
        {
          path: "title",
          label: "Title",
          operation: "create",
          after: "Ada Lovelace",
        },
        {
          path: "profileSlug",
          label: "ProfileSlug",
          operation: "create",
          after: "person",
        },
        {
          path: "properties.role",
          label: "Role",
          operation: "create",
          after: "CTO",
        },
        {
          path: "properties.started",
          label: "Started",
          operation: "create",
          after: "2026-10-01",
        },
        {
          path: "resolvedWorkspaceId",
          label: "ResolvedWorkspaceId",
          operation: "create",
          after: null,
        },
      ],
    },
  };
}

/** A capture graph whose one new person has a record twin. */
function graphCapture() {
  const data = {
    operations: [
      {
        op: "create_entity",
        ref: "e0",
        profileSlug: "person",
        title: "Ada Lovelace",
        properties: { role: "CTO" },
      },
      {
        op: "create_entity",
        ref: "e1",
        profileSlug: "company",
        title: "Analytical Engines",
      },
    ],
    duplicateCheck: {
      status: "possible",
      subject: "entity",
      candidates: [{ ...TWIN, forRef: "e0", forTitle: "Ada Lovelace" }],
    },
  };
  return {
    ...personCreate(null),
    proposalType: "create",
    targetName: "Ada Lovelace",
    governanceReason: "POSSIBLE_DUPLICATE",
    data,
    request: { targetType: "entity", changeType: "create", data },
    review: { reasoning: undefined, changes: [] },
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

const press = (key: string) => {
  const fn = presses.get(key);
  expect(fn, `a button "${key}" was rendered`).toBeTypeOf("function");
  fn!();
};

beforeEach(() => {
  presses.clear();
  approveCalls.length = 0;
  state.defs = [];
});

describe("a create the pod matched to an existing record", () => {
  const withTwin = () =>
    personCreate({ status: "possible", subject: "entity", candidates: [TWIN] });

  it("shows the existing record as a door, with why it matched", () => {
    state.proposal = withTwin();
    const html = render();
    const twins = html.slice(html.indexOf("data-review-twins"));
    expect(twins).toContain(`href="/open/entity/${ids.TWIN}"`);
    expect(text(twins)).toMatch(/Looks like Ada Lovelace Same name/);
  });

  it("offers the four verbs INSTEAD of a plain Approve or an always-approve", () => {
    state.proposal = withTwin();
    const seen = text(render());
    for (const verb of [
      "Fill empty fields",
      "Use existing",
      "Overwrite with these",
      "Keep both",
    ]) {
      expect(seen).toContain(verb);
    }
    expect(presses.has("Approve")).toBe(false);
    expect(seen).not.toMatch(/\bApprove\b/);
    expect(seen).toContain("Reject…");
  });

  it("the verb pressed is the resolution the pod receives", () => {
    state.proposal = withTwin();
    render();
    press("keep_existing");
    press("separate");
    expect(approveCalls).toEqual([
      {
        proposalId: ids.PROPOSAL,
        identityResolution: {
          verb: "keep_existing",
          existingEntityId: ids.TWIN,
        },
      },
      { proposalId: ids.PROPOSAL, identityResolution: { verb: "separate" } },
    ]);
  });

  it("several twins: a record is picked before a record-bound verb exists", () => {
    state.proposal = personCreate({
      status: "possible",
      subject: "entity",
      candidates: [
        TWIN,
        { ...TWIN, id: ids.TWIN_2, why: "same_identity", sample: true },
      ],
    });
    const seen = text(render());
    expect(seen).toContain("Which record is it?");
    expect(seen).toContain("Pick the record first.");
    expect(seen).toContain("Same identity · Sample");
    expect(presses.has("fill_empty")).toBe(false);
    press("separate");
    expect(approveCalls).toEqual([
      { proposalId: ids.PROPOSAL, identityResolution: { verb: "separate" } },
    ]);
  });
});

describe("a create with no twin", () => {
  it("keeps the plain Approve, and sends no resolution", () => {
    state.proposal = personCreate(null);
    const seen = text(render());
    expect(seen).not.toContain("Looks like");
    expect(seen).not.toContain("Keep both");
    press("Approve");
    expect(approveCalls).toEqual([{ proposalId: ids.PROPOSAL }]);
  });
});

describe("a capture graph with a twin", () => {
  it("draws one card per new item, the choice inside its item's card", () => {
    state.proposal = graphCapture();
    const html = render();
    const ada = html.slice(
      html.indexOf('data-proposed-record="e0"'),
      html.indexOf('data-proposed-record="e1"')
    );
    expect(ada).toContain('data-item-choice="e0"');
    expect(ada).toContain(`href="/open/entity/${ids.TWIN}"`);
    expect(text(html)).toContain("Analytical Engines");
  });

  it("its Approve sends one choice per item, keyed by the item's ref", () => {
    state.proposal = graphCapture();
    render();
    press("Approve");
    expect(approveCalls).toEqual([
      {
        proposalId: ids.PROPOSAL,
        identityResolutionByRef: {
          e0: { verb: "fill_empty", existingEntityId: ids.TWIN },
        },
      },
    ]);
  });
});

describe("the record card", () => {
  it("the record's name is the heading and its kind a mark — not rows", () => {
    state.proposal = personCreate(null);
    const html = render();
    const card = html.slice(html.indexOf("data-proposed-record"));
    expect(card).toMatch(/<h2[^>]*>Ada Lovelace<\/h2>/);
    expect(card).toContain("data-record-kind");
    expect(html).not.toContain('data-record-field="title"');
    expect(html).not.toContain('data-record-field="profileSlug"');
  });

  it("machine keys and empty values never show", () => {
    state.proposal = personCreate(null);
    const html = render();
    // The card only — the raw request in Advanced keeps every key.
    const card = text(
      html.slice(
        html.indexOf("data-proposed-record"),
        html.indexOf("data-review-decision")
      )
    );
    expect(card).toContain("CTO");
    expect(card).not.toMatch(/ResolvedWorkspaceId|Resolved workspace/i);
    expect(card).not.toMatch(/\bempty\b/);
  });

  it("a property is labelled by its definition, values read as plain text", () => {
    state.proposal = personCreate(null);
    state.defs = [
      {
        id: "d1",
        slug: "role",
        valueType: "string",
        uiHints: { displayName: "Job title" },
      },
      { id: "d2", slug: "started", valueType: "date" },
    ];
    const html = render();
    const role = html.slice(
      html.indexOf('data-record-field="properties.role"'),
      html.indexOf('data-record-field="properties.started"')
    );
    expect(text(role)).toContain("Job title CTO");
    // Plain text, not a chip.
    expect(role).toContain('<span class="break-words">CTO</span>');
    // A date reads as a date, not as the stored string.
    expect(text(html)).not.toContain("2026-10-01");
  });
});

describe("why, the note and undo", () => {
  const withTwin = () =>
    personCreate({ status: "possible", subject: "entity", candidates: [TWIN] });

  it("the reason is ONE mark; its sentence waits behind it", () => {
    state.proposal = withTwin();
    const html = render();
    expect(html).toContain('data-review-mark="Possible duplicate"');
    expect(text(html)).not.toContain(
      GOVERNANCE_POLICY_SENTENCES.POSSIBLE_DUPLICATE
    );
    expect(text(html)).not.toMatch(/Always asks a person/);
  });

  it("the agent's words are labelled as theirs", () => {
    state.proposal = withTwin();
    expect(text(render())).toMatch(
      /Note from Claude-code Same kind and name as a person you have/
    );
  });

  it("an undoable change draws no undo copy at all", () => {
    state.proposal = withTwin();
    const seen = text(render());
    expect(seen).not.toMatch(/Can be undone|undo it from its history/);
  });
});
