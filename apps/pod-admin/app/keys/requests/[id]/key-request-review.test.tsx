/**
 * The key request Review, RENDERED (react-dom/server; pod-admin's vitest runs
 * in node) and DRIVEN: each button's `onPress` is recorded as it renders, then
 * pressed, and the `apiKeys.decideKeyRequest` input that reaches the tRPC
 * client is asserted.
 *
 * What the page got wrong (finding da59b051), each pinned here:
 *  - the key was said twice (a header sentence, then the same sentence and
 *    marks in a bordered review bar under the form);
 *  - the whole New key form sat in an accordion inside the card;
 *  - "Deny" and "Request denied" were hand-written beside the vocabulary's
 *    "Reject" / "Rejected".
 *
 * Fixtures are the wire shape `apiKeys.getKeyRequest` returns (invented ids).
 */
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/keys/requests/x",
  useRouter: () => ({ replace() {}, push() {} }),
}));

const { state, presses, decideCalls, ids } = vi.hoisted(() => ({
  state: { request: null as unknown },
  presses: new Map<string, () => void>(),
  decideCalls: [] as unknown[],
  ids: {
    REQUEST: "11111111-1111-4111-8111-111111111111",
    COMPUTER: "22222222-2222-4222-8222-222222222222",
    SPACE: "33333333-3333-4333-8333-333333333333",
  },
}));

/* Record each button's press under its text, and render the real button. */
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  const Button = (props: Record<string, unknown>) => {
    if (
      typeof props.children === "string" &&
      typeof props.onPress === "function"
    )
      presses.set(props.children, props.onPress as () => void);
    return createElement(real.Button, props as never);
  };
  return { ...real, Button };
});

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      apiKeys: { getKeyRequest: { invalidate: async () => undefined } },
    }),
    apiKeys: {
      getKeyRequest: {
        useQuery: () => ({
          data: state.request,
          isLoading: false,
          isError: false,
          error: null,
          refetch() {},
        }),
      },
      decideKeyRequest: {
        useMutation: () => ({
          mutateAsync: async (input: unknown) => {
            decideCalls.push(input);
            return { status: "approved" };
          },
          isPending: false,
        }),
      },
    },
    workspaces: {
      list: {
        useQuery: () => ({
          data: [{ id: ids.SPACE, name: "Builder" }],
          isError: false,
        }),
      },
    },
    projects: {
      list: { useQuery: () => ({ data: { items: [] }, isError: false }) },
    },
    profiles: {
      list: { useQuery: () => ({ data: { profiles: [] }, isError: false }) },
    },
  },
}));

import { describeKey, type KeyDraft } from "@synap-core/types/grants";
import { KeyRequestReview } from "./KeyRequestReview";

const asked: KeyDraft = {
  name: "Dev loop poster",
  templateId: "dev-loop-poster",
  uses: ["hub"],
  grant: {
    permissions: ["event.create"],
    workspaceIds: [ids.SPACE],
    expiresInDays: 90,
  },
};

function request(status: string) {
  return {
    requestId: ids.REQUEST,
    status,
    requester: { userId: ids.COMPUTER, name: "devbox", isComputer: true },
    template: {
      id: "dev-loop-poster",
      name: "Dev loop poster",
      description: "Posts what happened to the pod's activity.",
    },
    draft: asked,
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    expiresAt: new Date(Date.now() + 20 * 3_600_000),
  };
}

const render = () =>
  renderToStaticMarkup(
    createElement(KeyRequestReview, {
      requestId: ids.REQUEST,
      identity: "ada@example.com",
    })
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  presses.clear();
  decideCalls.length = 0;
});

describe("a pending key request", () => {
  it("names what approving does, and says the key once", () => {
    state.request = request("pending");
    const html = render();
    expect(html).toContain("Create API key · Dev loop poster");
    expect(html).toContain("Pending");
    // The change, once: one summary, one "What it asks for", no New key
    // review bar and no sentence repeated under it.
    expect(count(html, "data-key-access")).toBe(1);
    expect(count(html, 'aria-label="What it asks for"')).toBe(1);
    expect(html).not.toContain("data-key-review");
    expect(html).not.toContain(describeKey(asked).sentence);
    // Activity · Post, said once.
    expect(count(html, ">Activity<")).toBe(1);
    expect(count(html, ">Post<")).toBe(1);
    // Who asks, where, as chips.
    expect(html).toContain("devbox");
    expect(html).toContain("Builder");
  });

  it("is never a form boxed in an accordion", () => {
    state.request = request("pending");
    const html = render();
    // The old page's accordion item was named "Narrow it".
    expect(html).not.toContain('aria-label="Narrow it"');
    // The family rows open only on "Narrow it".
    expect(html).not.toContain('data-family="activity"');
    expect(presses.has("Narrow it")).toBe(false); // a quiet text button, not a Button
    expect(html).toContain("Narrow it");
  });

  it("offers the vocabulary's verbs, never a hand-written Deny", () => {
    state.request = request("pending");
    const html = render();
    expect(presses.has("Approve")).toBe(true);
    expect(presses.has("Reject…")).toBe(true);
    expect(html).not.toContain("Deny");
    expect(html).not.toContain("Decline");
  });

  it("Approve sends the key as asked, through the one decision door", async () => {
    state.request = request("pending");
    render();
    presses.get("Approve")!();
    await vi.waitFor(() => expect(decideCalls).toHaveLength(1));
    expect(decideCalls[0]).toMatchObject({
      requestId: ids.REQUEST,
      decision: "approve",
      draft: {
        name: "Dev loop poster",
        templateId: "dev-loop-poster",
        uses: ["hub"],
        grant: {
          permissions: ["event.create"],
          workspaceIds: [ids.SPACE],
          expiresInDays: 90,
        },
      },
    });
  });
});

describe("a closed key request", () => {
  // Rules out: "Request denied" beside proposals' "Rejected".
  it("a refused request reads Rejected, with no verb left", () => {
    state.request = request("denied");
    const html = render();
    expect(html).toContain("Rejected");
    expect(html).not.toContain("Request denied");
    expect(presses.has("Approve")).toBe(false);
    expect(presses.has("Reject…")).toBe(false);
  });

  it("a collected key reads Approved and points to the person's keys", () => {
    state.request = request("consumed");
    const html = render();
    expect(html).toContain("Approved");
    expect(html).toContain("devbox collected the key");
    expect(html).toContain('href="/my-connections"');
  });
});
