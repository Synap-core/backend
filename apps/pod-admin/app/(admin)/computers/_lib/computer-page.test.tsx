/**
 * `/computers/[id]` RENDERED (react-dom/server) over the REAL route and the
 * REAL `ComputerObject`, against a tRPC stub that answers the computers list.
 * Pinned (L8, focus wave 4 Nov): whose computer it is (0388) is a fact on the
 * page and changes here. `machines.setBelongsTo` had no door anywhere, and
 * the device approval offers no choice, so every computer stayed "Personal".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  id: "pc-1",
  answers: new Map<string, unknown>(),
  /** Every tRPC path the page asked a mutation hook for. */
  mutations: new Set<string>(),
}));

/** Every `trpc.<path>.useQuery` answers from `h.answers`, settled. */
vi.mock("../../../../lib/trpc", () => {
  const leaf = (path: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, key: string) {
        if (key === "useQuery") {
          return () => {
            const data = h.answers.get(path);
            return {
              data,
              isLoading: false,
              isSuccess: data !== undefined,
              isError: false,
              error: null,
              refetch: () => undefined,
            };
          };
        }
        if (key === "useQueries") return () => [];
        if (key === "useMutation") {
          return () => {
            h.mutations.add(path);
            return { mutate: vi.fn(), isPending: false };
          };
        }
        if (key === "useUtils") return () => leaf("utils");
        return leaf(path ? `${path}.${key}` : key);
      },
    });
  return { trpc: leaf("") };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: h.id }),
  useRouter: () => ({ replace() {}, push() {} }),
  usePathname: () => `/computers/${h.id}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../_lib/object/use-reauth", () => ({
  useReauthOnUnauthorized: () => undefined,
}));

import ComputerPage from "../[id]/page";

function computer(over: Record<string, unknown>) {
  return {
    id: h.id,
    name: "Build box",
    hostname: "build.local",
    platform: "linux",
    createdAt: "2026-11-01T20:12:00.000Z",
    lastSeenAt: null,
    key: null,
    keyTtlDays: null,
    effectiveKeyTtlDays: 90,
    minKeyTtlDays: 1,
    maxKeyTtlDays: 365,
    accessName: null,
    runsScripts: false,
    agents: [],
    owner: { id: "u-1", name: "Ada" },
    ...over,
  };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("/computers/[id] — whose computer it is", () => {
  it("names it as a fact and offers the three answers", () => {
    h.answers.set("machines.adminList", [computer({ belongsTo: "agent" })]);
    const page = text(renderToStaticMarkup(<ComputerPage />));
    expect(page).toContain("Whose it is");
    expect(page).toContain("Whose computer it is");
    for (const label of ["Personal", "An agent's", "Shared"]) {
      expect(page).toContain(label);
    }
  });

  // Rules out (review S5): an older computer with no door to classify it,
  // and a guessed answer.
  it("a row from before 0388 offers the three answers with none chosen", () => {
    h.answers.set("machines.adminList", [computer({})]);
    const html = renderToStaticMarkup(<ComputerPage />);
    const page = text(html);
    expect(page).toContain("Whose computer it is");
    expect(page).toContain("Not set yet. Choose one.");
    for (const label of ["Personal", "An agent's", "Shared"]) {
      expect(page).toContain(label);
    }
    expect(page).not.toContain("Whose it is");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios.filter((r) => /\schecked/.test(r))).toEqual([]);
  });
});

// Rules out (backend#909 review): a command written as literal backticks in a
// sentence, `waker install` handed to a computer it throws on (macOS only),
// and "installed but not running" read as "never ran".
describe("/computers/[id] — the Wakes agents card", () => {
  const render = (over: Record<string, unknown>) => {
    h.answers.set("machines.adminList", [computer(over)]);
    const html = renderToStaticMarkup(<ComputerPage />);
    return { html, page: text(html) };
  };

  it("no waker ever ran: the command that starts one, per OS, never in backticks", () => {
    const linux = render({ wakesAgents: true, waker: null });
    expect(linux.page).toContain("Start its waker on Build box:");
    expect(linux.html).toContain(">npx @synap-core/cli waker</code>");
    expect(linux.page).toContain(
      "On Linux, keep it running (a service manager can start it at boot)."
    );
    expect(linux.page).not.toContain("waker install");
    expect(linux.page).not.toContain("`");

    const mac = render({ platform: "darwin", wakesAgents: false, waker: null });
    expect(mac.html).toContain(">npx @synap-core/cli waker install</code>");
    expect(mac.page).not.toContain("keep it running");
    expect(mac.page).not.toContain("`");
  });

  it("a waker that ran but is not running now: says so and hands over status", () => {
    const { html, page } = render({
      wakesAgents: true,
      waker: { online: false, wakesAgents: true },
    });
    expect(page).toContain("Build box's waker isn't running right now.");
    expect(html).toContain(">npx @synap-core/cli waker status</code>");
    expect(page).not.toContain("Start its waker");
  });

  it("a running waker with the switch off: says it runs and what turning it on does", () => {
    const { html, page } = render({
      wakesAgents: false,
      waker: { online: true, wakesAgents: false },
    });
    expect(page).toContain(
      "Its waker is running. Turn this on and Build box starts its agents when work is handed to them."
    );
    expect(html).not.toContain("@synap-core/cli waker");
    expect(page).toContain("Wake agents here");
  });
});

// Rules out (backend#779 follow-up): the CLI's refusal tells the person to
// turn on "Installs from the pod" in pod admin › Computers, and no such
// switch existed; `machines.setHostsServices` had no door anywhere.
describe("/computers/[id] — the Installs from the pod card", () => {
  const render = (over: Record<string, unknown>) => {
    h.mutations.clear();
    h.answers.set("machines.adminList", [computer(over)]);
    return text(renderToStaticMarkup(<ComputerPage />));
  };

  it("off: says what turning it on does, and wires machines.setHostsServices", () => {
    const page = render({ hostsServices: false });
    expect(page).toContain("Installs from the pod");
    expect(page).toContain(
      "Let Build box install, update and remove the tools Ada approves for it."
    );
    expect(page).toContain("Install from the pod here");
    expect(h.mutations).toContain("machines.setHostsServices");
  });

  it("on: says what it does now and offers to stop", () => {
    const page = render({ hostsServices: true });
    expect(page).toContain(
      "Build box installs, updates and removes the tools Ada approves for it."
    );
    expect(page).toContain("Stop installing from the pod");
    expect(page).not.toContain("Install from the pod here");
  });

  it("a revoked computer offers no switch", () => {
    const page = render({
      hostsServices: true,
      key: { state: "revoked" },
    });
    expect(page).toContain("Build box");
    expect(page).not.toContain("Installs from the pod");
    expect(page).not.toContain("Stop installing from the pod");
  });
});
