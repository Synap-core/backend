/**
 * The open request's story (`useOpenStory`, review-drawer.tsx): a row the
 * page's one context read does not cover yet (it arrived after the cached
 * read) is read again ONCE, and stays "reading" until that read answers.
 * Once PER ROW (code review): the re-read is keyed by the row it was asked
 * for, so the NEXT uncovered row opened in the same detail is read again too
 * — before, the first re-read spent the only one for every row after it.
 *
 * Node has no DOM and a server render runs no effect, so `ReviewDetail` is
 * driven through a minimal hook harness (state kept across renders, effects
 * run after each render, as React commits them). `ReviewDetail` is reached
 * through the element `ReviewInline` returns; what it hands its body
 * (`story`) is read off the element it returns, never rendered.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const h = vi.hoisted(() => {
  let slots: unknown[] = [];
  let at = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  const harness = {
    reset() {
      slots = [];
    },
    /** Render `fn` as React would: effects after it, again while state moved. */
    render<T>(fn: () => T): T {
      let out!: T;
      for (let pass = 0; pass < 10; pass++) {
        at = 0;
        dirty = false;
        effects = [];
        out = fn();
        for (const effect of effects) effect();
        if (!dirty) return out;
      }
      throw new Error("the hook harness did not settle");
    },
    useState<S>(init: S | (() => S)) {
      const i = at++;
      if (!(i in slots))
        slots[i] = typeof init === "function" ? (init as () => S)() : init;
      const set = (next: S | ((prev: S) => S)) => {
        slots[i] =
          typeof next === "function"
            ? (next as (prev: S) => S)(slots[i] as S)
            : next;
        dirty = true;
      };
      return [slots[i] as S, set] as const;
    },
    useEffect(effect: () => void, deps?: unknown[]) {
      const i = at++;
      const prev = slots[i] as unknown[] | undefined;
      const changed =
        !prev ||
        !deps ||
        deps.length !== prev.length ||
        deps.some((d, k) => !Object.is(d, prev[k]));
      if (changed) {
        slots[i] = deps;
        effects.push(effect);
      }
    },
  };
  return harness;
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: h.useState,
  useEffect: h.useEffect,
}));
vi.mock("../../../../lib/i18n/locale-provider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../lib/i18n/locale-provider")
  >()),
  useConsoleLocale: () => "en",
}));
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { ReviewInline, type ReviewStoryContext } from "./review-drawer";
import { reviewRows } from "./review-rows";
import type { StoryRead } from "../../../_lib/request/request-story-view";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const proposalRow = (proposalId: string) => {
  const [row] = reviewRows(
    [
      {
        id: `proposal-cluster:${proposalId}`,
        kind: "proposal-cluster",
        title: `Create ${proposalId.slice(0, 4)}`,
        count: 1,
        groupKey: null,
        ageBucket: "today",
        repeatCount: 1,
        category: "ai",
        target: { kind: "proposal", id: proposalId },
        proposalIds: [proposalId],
        source: { kind: "session", id: SESSION_ID, label: "Build wave 2" },
      },
    ] as never,
    new Map()
  );
  return row!;
};
const A = proposalRow("11111111-1111-4111-8111-111111111111");
const B = proposalRow("33333333-3333-4333-8333-333333333333");

/** The page's one context read: answered, covering none of the rows. */
function context(refetch: () => void, updatedAt: number): ReviewStoryContext {
  return {
    context: { rows: {}, sessions: {}, timelineItems: 0 } as never,
    read: { status: "ok" },
    refetch,
    updatedAt,
  };
}

/** Render the detail for `row` and read the story it hands its body. */
function storyFor(
  row: typeof A,
  ctx: ReviewStoryContext
): { read: StoryRead } | undefined {
  const el = ReviewInline({
    open: {
      detail: row.detail as never,
      title: "t",
      lens: row.lens,
    },
    viewer: {},
    onClose: () => {},
    liveAsk: null,
    onAskSettled: () => {},
    storyContext: ctx,
  }) as ReactElement<Record<string, unknown>>;
  const Detail = el.type as (p: unknown) => ReactElement<{
    children: Array<ReactElement<{ story?: { read: StoryRead } }> | false>;
  }>;
  const out = h.render(() => Detail(el.props));
  const body = out.props.children.find(
    (c): c is ReactElement<{ story?: { read: StoryRead } }> =>
      !!c && typeof c === "object" && "story" in (c.props ?? {})
  );
  return body?.props.story;
}

beforeEach(() => h.reset());

describe("useOpenStory — an uncovered row is read again, once per row", () => {
  it("fixtures: both rows are proposal rows the context does not cover", () => {
    expect(A.detail?.kind).toBe("proposal");
    expect(B.detail?.kind).toBe("proposal");
    expect(A.lens.key).not.toBe(B.lens.key);
  });

  it("an uncovered row: read again ONCE, 'reading' meanwhile, then told from the row alone", () => {
    const refetch = vi.fn();
    expect(storyFor(A, context(refetch, 100))?.read.status).toBe("loading");
    expect(refetch).toHaveBeenCalledTimes(1);
    // The same row, the read not answered yet: no second read.
    expect(storyFor(A, context(refetch, 100))?.read.status).toBe("loading");
    expect(refetch).toHaveBeenCalledTimes(1);
    // The read answered and still does not cover it: no third read, and not
    // a failure either.
    expect(storyFor(A, context(refetch, 200))?.read.status).toBe("off");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a SECOND uncovered row opened in the same detail is read again too", () => {
    const refetch = vi.fn();
    storyFor(A, context(refetch, 100));
    storyFor(A, context(refetch, 200));
    expect(refetch).toHaveBeenCalledTimes(1);
    // B arrives after that read: its own re-read, and 'reading' until it lands.
    expect(storyFor(B, context(refetch, 200))?.read.status).toBe("loading");
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(storyFor(B, context(refetch, 300))?.read.status).toBe("off");
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
