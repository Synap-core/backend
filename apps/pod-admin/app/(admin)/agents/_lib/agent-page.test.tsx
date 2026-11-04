/**
 * `/agents/[id]` RENDERED (react-dom/server; pod-admin's vitest runs in node):
 * the REAL route over the REAL `AgentObject` — the body `/open/agent/:id`
 * draws — against a tRPC stub that answers the roster, the viewer and the
 * pod's members. Founder, 2026-11-03: an agent has its own page in the
 * console, like a computer. Pinned: the page is the agent's object page for
 * the id in the address, framed in the console (crumb back to Agents), with
 * its computer, its keys and its owner as doors.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  id: "11111111-1111-4111-8111-111111111111",
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
  usePathname: () => `/agents/${h.id}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../../lib/exit-link", () => ({
  ExitLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../../_lib/object/use-reauth", () => ({
  useReauthOnUnauthorized: () => undefined,
}));

import AgentPage from "../[id]/page";

const OWNER = "22222222-2222-4222-8222-222222222222";
const COMPUTER = "33333333-3333-4333-8333-333333333333";
const OTHER = "55555555-5555-4555-8555-555555555555";

function answer() {
  h.answers.set("users.me", { id: "44444444-4444-4444-8444-444444444444" });
  h.answers.set("workspaces.listPodMembers", [
    { id: OWNER, name: "Ada Lovelace", email: "ada@example.com" },
  ]);
  h.answers.set("agentUsers.list", [
    {
      id: h.id,
      name: "Build worker",
      lastSeenAt: null,
      host: null,
      activeKeys: 1,
      pendingKeys: 0,
      revokedKeys: 0,
      origin: "cli",
      createdByUserId: OWNER,
      hostComputer: { id: COMPUTER, name: "Build box" },
    },
    {
      id: OTHER,
      name: "Other worker",
      lastSeenAt: null,
      host: null,
      activeKeys: 1,
      pendingKeys: 0,
      revokedKeys: 0,
      origin: "cli",
      createdByUserId: OWNER,
      hostComputer: null,
    },
  ]);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("/agents/[id] — the agent's page in the console", () => {
  it("draws the agent of the address as its object page", () => {
    answer();
    const html = renderToStaticMarkup(<AgentPage />);
    expect(text(html)).toContain("Build worker");
    // The agent of the address, never another one on the roster.
    expect(text(html)).not.toContain("Other worker");
  });

  it("is framed in the console: a crumb back to Agents", () => {
    answer();
    const html = renderToStaticMarkup(<AgentPage />);
    expect(html).toMatch(/href="\/agents"[^>]*>\s*Agents\s*</);
  });

  it("opens its computer, its keys and its owner from the page", () => {
    answer();
    const html = renderToStaticMarkup(<AgentPage />);
    expect(html).toContain(`href="/computers/${COMPUTER}"`);
    expect(html).toContain(`href="/keys?q=Build%20worker"`);
    expect(html).toContain(`href="/members?focus=${OWNER}"`);
    expect(text(html)).toContain("Ada Lovelace");
  });
});
