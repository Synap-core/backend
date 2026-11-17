import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ history: [] as unknown[] }));

vi.mock("../../../../lib/trpc", () => {
  const answer = (data: unknown) => ({
    data,
    isLoading: false,
    isError: false,
    refetch: () => undefined,
  });
  return {
    trpc: {
      runs: {
        // History asks without a status; "Running now" asks for running.
        list: {
          useQuery: (input: { status?: string }) =>
            answer({ runs: input.status ? [] : h.history }),
        },
        recentByFlows: { useQuery: () => answer({ histories: [] }) },
      },
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The exit's own behaviour is `exit-link`'s; here only where it points.
vi.mock("../../../../lib/exit-link", () => ({
  ExitLink: ({ exit, label }: { exit: { href: string }; label: string }) => (
    <a href={exit.href}>{label}</a>
  ),
}));

import { ToolRuns, toolInApp } from "./tool-runs";

const CAP = "11111111-1111-4111-8111-111111111111";

function run(i: number) {
  return {
    id: `r${i}`,
    flowType: "capability",
    flowName: "hetzner.create_server",
    status: "completed",
    startedAt: new Date("2026-11-16T10:00:00Z"),
    completedAt: new Date("2026-11-16T10:01:00Z"),
  };
}

function draw(n: number) {
  h.history = Array.from({ length: n }, (_, i) => run(i));
  return renderToStaticMarkup(
    <ToolRuns tool={{ capabilityId: CAP }} actionLabel={(f) => f} />
  );
}

describe("ToolRuns history: a capped list gets Show all", () => {
  it("offers the tool in the desktop app once the page is full", () => {
    const out = draw(10);
    expect(out).toContain("Show all its runs in the desktop app");
    expect(out).toContain(`href="synap://open/capability/${CAP}"`);
  });

  it("offers nothing more when the history is shorter than the cap", () => {
    expect(draw(3)).not.toContain("Show all its runs");
  });

  it("opens a skill's own page in the app for a skill", () => {
    expect(toolInApp({ skillId: "s1" }).href).toBe("synap://open/skill/s1");
  });
});
