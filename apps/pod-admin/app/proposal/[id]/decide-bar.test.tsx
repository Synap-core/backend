/**
 * The decision bar of a request, RENDERED (react-dom/server; pod-admin's
 * vitest runs in node):
 *  - in French, the outcome sentence and the repair card read French: no
 *    English sentence is left beside the French menus;
 *  - while any decision is in flight, every verb of the bar holds, the two
 *    rule menus included, so a second click cannot start a second decision.
 */
import { createElement } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

vi.mock("../../(admin)/components/side-nav-role", () => ({
  useConsoleRole: () => "admin",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/proposal",
  useRouter: () => ({ replace() {}, push() {} }),
}));

const { state, menuProps } = vi.hoisted(() => ({
  state: {
    proposal: null as unknown,
    approving: false,
    rejecting: false,
  },
  menuProps: {
    always: null as null | Record<string, unknown>,
    never: null as null | Record<string, unknown>,
  },
}));

/* The real menus, with their props recorded. */
vi.mock("./AlwaysApproveMenu", async (importOriginal) => {
  const real = await importOriginal<typeof import("./AlwaysApproveMenu")>();
  return {
    ...real,
    AlwaysApproveMenu: (props: Record<string, unknown>) => {
      menuProps.always = props;
      return createElement(real.AlwaysApproveMenu, props as never);
    },
    RejectNeverMenu: (props: Record<string, unknown>) => {
      menuProps.never = props;
      return createElement(real.RejectNeverMenu, props as never);
    },
  };
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
      source: { useQuery: () => ({ data: { targets: [] } }) },
      approve: {
        useMutation: () => ({
          mutate() {},
          mutateAsync: async () => ({}),
          isPending: state.approving,
        }),
      },
      reject: {
        useMutation: () => ({
          mutate() {},
          mutateAsync: async () => ({}),
          isPending: state.rejecting,
        }),
      },
      approvalProgress: {
        useQuery: () => ({
          data: null,
          isError: false,
          isFetching: false,
          refetch() {},
        }),
      },
      repairOptions: {
        useQuery: () => ({
          data: { repairable: false, missingKind: "widget" },
          isError: false,
          isLoading: false,
          refetch() {},
        }),
      },
      repair: { useMutation: () => ({ mutate() {}, isPending: false }) },
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

const AGENT = "55555555-5555-4555-8555-555555555555";
const ID = "11111111-1111-4111-8111-111111111111";

function request(status: string) {
  const record = {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Ada Lovelace",
    global: false,
    properties: { role: "CTO" },
    profileSlug: "person",
    resolvedWorkspaceId: null,
  };
  return {
    id: ID,
    workspaceId: null,
    targetType: "entity",
    targetId: record.id,
    targetName: "Ada Lovelace",
    proposalType: "create",
    status,
    agentUserId: AGENT,
    governanceReason: null,
    createdAt: new Date(Date.now() - 3_600_000),
    authorName: "Claude-code",
    agentActorName: "Claude-code",
    principal: { kind: "delegated", name: "Grace Hopper" },
    revertable: true,
    data: { data: record, changeType: "create", targetType: "entity" },
    request: {
      targetType: "entity",
      targetId: record.id,
      changeType: "create",
      data: record,
    },
    review: { changes: [] },
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
    <ProposalReview proposalId={ID} identity="Grace Hopper" />
  );

beforeEach(() => {
  state.approving = false;
  state.rejecting = false;
  menuProps.always = null;
  menuProps.never = null;
});
afterEach(() => setAmbientCatalogLocale("en"));

const ENGLISH_OUTCOMES = [
  "You approved this change",
  "matched an auto-approve rule",
  "You rejected this",
  "was undone after it was applied",
  "Its moment passed",
  "withdrew this",
];

describe("in French", () => {
  it.each([
    "approved",
    "auto_approved",
    "rejected",
    "reverted",
    "expired",
    "withdrawn",
  ])("a %s request says its outcome in French", (status) => {
    setAmbientCatalogLocale("fr");
    state.proposal = request(status);
    const seen = text(render());
    for (const sentence of ENGLISH_OUTCOMES)
      expect(seen).not.toContain(sentence);
    expect(seen).toMatch(
      /Vous avez|règle d’approbation|prévenue|annulé|délai|retiré/
    );
  });

  it("the repair card of a failed approval has no English sentence", () => {
    setAmbientCatalogLocale("fr");
    state.proposal = request("approval_failed");
    const seen = text(render());
    expect(seen).toContain("L’approbation a échoué.");
    expect(seen).toContain("Le type « widget » n’existe pas ici");
    for (const english of [
      "Approving this failed",
      "does not exist here",
      "Checking what to fix",
    ]) {
      expect(seen).not.toContain(english);
    }
  });

  it("the decision bar names no English verb", () => {
    setAmbientCatalogLocale("fr");
    state.proposal = request("pending");
    const seen = text(render());
    expect(seen).toContain("Approuver et toujours autoriser…");
    expect(seen).not.toMatch(/\bApprove\b|\bReject\b/);
  });
});

describe("one pending state for the whole bar", () => {
  const held = (html: string, label: RegExp) => {
    const button = html
      .split("<button")
      .find((chunk) => label.test(text(chunk.split("</button>")[0] ?? "")));
    expect(button, `a button matching ${label}`).toBeTruthy();
    return /data-disabled="true"|disabled=""/.test(button!.split(">")[0]!);
  };

  it("nothing is held while nothing is deciding", () => {
    state.proposal = request("pending");
    const html = render();
    for (const label of [
      /Approve$/,
      /Reject…/,
      /Approve and always allow/,
      /Reject and never allow/,
    ]) {
      expect(held(html, label), String(label)).toBe(false);
    }
  });

  it.each([["approving"], ["rejecting"]] as const)(
    "while %s, every verb and both menus hold",
    (which) => {
      state[which] = true;
      state.proposal = request("pending");
      const html = render();
      for (const label of [
        /Approve/,
        /Reject…/,
        /Approve and always allow/,
        /Reject and never allow/,
      ]) {
        expect(held(html, label), String(label)).toBe(true);
      }
    }
  );

  it("each rule menu reports its decision to the bar, which holds the rest", () => {
    state.proposal = request("pending");
    render();
    expect(menuProps.always?.onRunningChange).toBeTypeOf("function");
    expect(menuProps.never?.onRunningChange).toBeTypeOf("function");
  });
});
