/**
 * The story's FRAME, rendered (react-dom/server; pod-admin's vitest runs in
 * node): one item per line, [when | rail mark | what]. Past lines sit on a
 * solid rail into Now; from Now on the rail is dashed (`rq-rail-next`). A
 * time is printed only when it changes from the line above. While the
 * context is read, its rows wait (`rq-mark-wait`); a failed read is its own
 * row (`rq-mark-unread`) with Try again; older steps fold into one first
 * row, a door to the whole story.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  RequestStory,
  RequestStoryGroup,
} from "@synap-core/types/needs-you";
import { en as REQUEST_EN } from "./copy";
import { RequestStoryView, type StoryRead } from "./request-story-view";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT = { kind: "agent", id: "a1", name: "Claude-code" } as const;
const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const group = (key: string, line: string, at: string): RequestStoryGroup =>
  ({
    key,
    kind: "checks_finished",
    line,
    count: 1,
    repeat: null,
    at,
    actor: AGENT,
    door: null,
    url: null,
    events: [],
  }) as unknown as RequestStoryGroup;

/** Two lines at the same time, then one later; one older line folded. */
const STORY = {
  head: {
    by: { id: "a1", label: "Claude-code" },
    cause: null,
    session: {
      id: SESSION_ID,
      title: "Build wave 2",
      door: { kind: "session", id: SESSION_ID },
    },
  },
  before: [
    group("g1", "Checks failed", ago(5 * H)),
    group("g2", "Checks passed", ago(5 * H)),
    group("g3", "Opened o/r#7", ago(2 * H)),
  ],
  folded: { groups: 1, events: 1, label: "1 more event" },
  olderExist: false,
  timelineDoor: { kind: "session", id: SESSION_ID },
  now: {
    title: "Ship it?",
    detail: null,
    at: null,
    verb: null,
    door: null,
    meanwhile: null,
    subject: null,
  },
  after: [],
  unreadable: [],
} as unknown as RequestStory;

const render = (story: RequestStory | null, read: StoryRead) =>
  renderToStaticMarkup(
    <RequestStoryView
      story={story}
      read={read}
      afterExtra={<p data-next-extra="">If you approve, it is applied.</p>}
      footer={<div data-footer="" />}
    >
      <p data-decided="">The change</p>
    </RequestStoryView>
  );

/** The timeline's items, in order: node, mark, rail below, when column. */
function items(html: string) {
  const ol = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
  return ol
    .split('<li data-story-node="')
    .slice(1)
    .map((li) => ({
      node: li.slice(0, li.indexOf('"')),
      mark: /rq-mark-(\w+)/.exec(li)?.[1] ?? null,
      rail: /rq-rail-(done|next)/.exec(li)?.[1] ?? null,
      when: /rq-when-col[^"]*">([^<]*)</.exec(li)?.[1] ?? "",
      html: li,
    }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the story's frame", () => {
  it("the rail is solid through the past into Now, dashed from Now on, none below the last", () => {
    const list = items(render(STORY, { status: "ok" }));
    const now = list.findIndex((i) => i.node === "now");
    expect(now).toBeGreaterThan(0);
    for (const item of list.slice(0, now)) expect(item.rail).toBe("done");
    // Below Now the rail turns dashed: what comes next is not yet.
    expect(list[now]!.rail).toBe("next");
    for (const item of list.slice(now + 1, -1)) expect(item.rail).toBe("next");
    expect(list.at(-1)!.rail).toBeNull();
    expect(list[now]!.mark).toBe("now");
    expect(list.slice(now + 1).every((i) => i.mark === "next")).toBe(true);
  });

  it("a time is printed only when it changes from the line above", () => {
    const past = items(render(STORY, { status: "ok" })).filter(
      (i) => i.node === "past" && !i.html.includes("data-story-fold")
    );
    expect(past.map((i) => text(i.when))).toEqual(["5h ago", "", "2h ago"]);
  });

  it("older steps fold into the first row: their count, then a door to the whole story", () => {
    const list = items(render(STORY, { status: "ok" }));
    expect(list[0]!.html).toContain("data-story-fold");
    const fold = text(list[0]!.html);
    expect(fold).toContain("1 more event");
    expect(fold).toContain(REQUEST_EN["story.fullTimeline"]);
    expect(list[0]!.html).toContain(`href="/open/session/${SESSION_ID}"`);
    // Folded, never drawn as a past line of its own.
    expect(list[0]!.html).not.toContain("data-story-event");
  });

  it("while the context is read, its rows wait (the wait mark), said to a screen reader", () => {
    const html = render(null, { status: "loading" });
    const list = items(html);
    const loading = list.filter((i) => i.node === "past");
    expect(loading).toHaveLength(2);
    expect(loading.every((i) => i.mark === "wait")).toBe(true);
    expect(html).toContain(REQUEST_EN["story.loading"]);
    // Never the failed read's mark while it is only in flight.
    expect(html).not.toContain("rq-mark-unread");
  });

  it("a failed read is its own row (the unread mark) with Try again; Now and the bar stay", () => {
    const html = render(null, { status: "error", retry: () => {} });
    const failed = items(html).find((i) =>
      i.html.includes('data-story-unreadable="all"')
    );
    expect(failed?.mark).toBe("unread");
    expect(text(failed!.html)).toContain(REQUEST_EN["story.failed"]);
    expect(failed!.html).toMatch(/<button[^>]*>.*Try again<\/button>/s);
    expect(html).toContain("data-decided");
    expect(html).toContain("data-footer");
    // A failed read is never told as "nothing else waits".
    expect(html).not.toContain(REQUEST_EN["story.nothingAfter"]);
  });

  it("the head says who asked and for what, before the timeline; the bar after it", () => {
    const html = render(STORY, { status: "ok" });
    const head = html.indexOf("data-story-head");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(head).toBeLessThan(html.indexOf("<ol"));
    expect(html.indexOf("data-footer")).toBeGreaterThan(html.indexOf("</ol>"));
    const seen = text(html.slice(head, html.indexOf("<ol")));
    expect(seen).toContain(REQUEST_EN["story.askedBy"]);
    expect(seen).toContain("Claude-code");
    expect(seen).toContain(REQUEST_EN["story.forSession"]);
    expect(seen).toContain("Build wave 2");
  });
});
