/**
 * The session page's Steps, RENDERED (react-dom/server) against a tRPC stub
 * that answers the work graph: each step draws its readiness as a word with a
 * glyph, the one door says "Open the plan in Synap", and a plan with no step
 * draws nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = "6f1c2c1e-0000-4000-8000-000000000001";

const h = vi.hoisted(() => ({
  graph: undefined as unknown,
  error: null as unknown,
  asked: [] as unknown[],
}));

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    focusSessions: {
      graph: {
        useQuery: (input: unknown) => {
          h.asked.push(input);
          return {
            data: h.graph,
            error: h.error,
            isLoading: false,
            refetch: () => undefined,
          };
        },
      },
    },
  },
}));
vi.mock("../use-reauth", () => ({ useReauthOnUnauthorized: () => undefined }));
vi.mock("../../../../lib/exit-link", () => ({
  ExitLink: ({ label, exit }: { label: string; exit: { href: string } }) => (
    <a href={exit.href}>{label}</a>
  ),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { PlanStepsSection } from "./plan-steps-section";

const step = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "forming",
  title: `Step ${id}`,
  inWindow: true,
  parentSessionId: ROOT,
  ...extra,
});

const draw = () =>
  renderToStaticMarkup(
    <PlanStepsSection
      sessionId={ROOT}
      hrefFor={(id) => `/open/session/${id}`}
    />
  );

beforeEach(() => {
  h.graph = undefined;
  h.error = null;
  h.asked = [];
});

describe("PlanStepsSection", () => {
  it("reads the canvas's own read, narrowed to this wave", () => {
    h.graph = { nodes: [], edges: [] };
    draw();
    expect(h.asked[0]).toEqual({
      rootSessionId: ROOT,
      kind: "all",
      lens: "all",
    });
  });

  it("draws each step's readiness as a word, and one door to the plan", () => {
    h.graph = {
      nodes: [
        step("a", { status: "closed", closedAs: "done" }),
        step("b"),
        step("c", { plannedFor: "2099-01" }),
      ],
      edges: [{ kind: "blocked_by", from: "b", to: "a" }],
      sections: { blockedBy: { status: "ok" } },
    };
    const html = draw();
    expect(html).toContain("Steps");
    for (const word of ["Done", "Ready", "Planned"]) {
      expect(html).toContain(word);
    }
    expect(html).toContain("Step a");
    expect(html).toContain('href="/open/session/b"');
    // One door, said in the person's words, to the desktop app.
    expect(html.match(/Open the plan in Synap/g)).toHaveLength(1);
    expect(html).toContain(`synap://open/session/${ROOT}`);
    // A glyph beside every word: no mark is colour alone.
    expect(html.match(/<svg/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("says a blocker read that failed", () => {
    h.graph = {
      nodes: [step("a")],
      edges: [],
      sections: { crossKind: { status: "unavailable" } },
    };
    expect(draw()).toContain("couldn’t be read, so they may show Planned");
  });

  it("is omitted when the plan has no step", () => {
    h.graph = {
      nodes: [{ ...step("root"), parentSessionId: null }],
      edges: [],
    };
    expect(draw()).toBe("");
  });

  it("says a failed read failed, never 'no steps'", () => {
    h.error = new Error("boom");
    const html = draw();
    expect(html).toContain("Its steps couldn’t be read.");
    expect(html).not.toContain("Open the plan in Synap");
  });
});
