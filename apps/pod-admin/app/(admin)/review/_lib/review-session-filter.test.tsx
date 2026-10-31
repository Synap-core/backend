/**
 * Review narrowed to one session names it from the SESSION READ — not from the
 * rows still waiting, which are gone on History and once the last one is
 * decided (the first version said "From one session" there). RENDERED
 * (react-dom/server; pod-admin's vitest runs in node). Names invented.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ replace() {}, push() {} }),
}));

const { state, SESSION_ID } = vi.hoisted(() => ({
  SESSION_ID: "22222222-2222-4222-8222-222222222222",
  state: { session: {} as { data?: unknown; error?: unknown } },
}));

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    focusSessions: {
      get: {
        useQuery: () => ({
          data: state.session.data,
          error: state.session.error ?? null,
        }),
      },
    },
  },
}));

import { SessionFilter } from "./review-session-filter";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const render = () =>
  renderToStaticMarkup(
    <SessionFilter sessionId={SESSION_ID} onClear={() => {}} />
  );

describe("SessionFilter — the narrowed session, named by its own read", () => {
  it("its title, as a door to the session", () => {
    state.session = { data: { title: "Build wave 2", goal: "Ship it" } };
    const html = render();
    expect(text(html)).toMatch(/From Build wave 2 Show everything/);
    expect(html).toContain(`href="/open/session/${SESSION_ID}"`);
  });

  it("no title of its own: named by its goal, as everywhere", () => {
    state.session = { data: { title: null, goal: "Ship the launch post" } };
    expect(text(render())).toMatch(/From Ship the launch post/);
  });

  it("unread or not readable: the kind's noun, never an id", () => {
    for (const session of [{}, { error: { data: { code: "NOT_FOUND" } } }]) {
      state.session = session;
      const seen = text(render());
      expect(seen).toMatch(/From Job Show everything/);
      expect(seen).not.toContain(SESSION_ID);
    }
  });
});
