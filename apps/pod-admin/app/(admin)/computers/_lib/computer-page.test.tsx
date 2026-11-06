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
          return () => ({ mutate: vi.fn(), isPending: false });
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
