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
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ replace() {}, push() {} }),
}));

/* Hoisted: `vi.mock` factories run before this file's own declarations. */
const {
  PROPOSAL_ID,
  SESSION_ID,
  AGENT_ID,
  TARGET_ID,
  NAME,
  PROPOSAL,
  TARGETS,
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
  return {
    PROPOSAL_ID,
    SESSION_ID,
    AGENT_ID,
    TARGET_ID,
    NAME,
    PROPOSAL,
    TARGETS,
  };
});

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    proposals: {
      get: {
        useQuery: () => ({
          data: PROPOSAL,
          isLoading: false,
          error: null,
          refetch() {},
        }),
      },
      source: { useQuery: () => ({ data: { targets: TARGETS } }) },
      approve: { useMutation: () => ({ mutate() {}, isPending: false }) },
      reject: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
    workspaces: { get: { useQuery: () => ({ data: undefined }) } },
    governanceRules: {
      create: { useMutation: () => ({ mutate() {}, isPending: false }) },
    },
  },
}));

import { ReviewDock } from "./review-drawer";
import { ProposalReview } from "../../../proposal/[id]/ProposalReview";

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
    expect(seen.indexOf("Finding")).toBeLessThan(seen.indexOf("Always asks"));
  });

  it("why: the policy as a mark + its sentence, and the proposer's own words", () => {
    const seen = text(render());
    expect(seen).toMatch(
      /Always asks a person This change alters the record's scope or identity/
    );
    expect(seen).toContain("Product problems move from finding to issue.");
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
    // Advanced is the last thing before the bar.
    expect(seen.indexOf("Advanced")).toBeLessThan(seen.indexOf("Reject…"));
  });
});
