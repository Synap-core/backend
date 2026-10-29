/**
 * The New key page, RENDERED (react-dom/server): purpose first, steps that
 * close as they are answered (decision a29a40d4). What it got wrong (finding
 * 44a38552): every section open at once — the kind × action matrix, the
 * powerful actions, every space and project — and "not usable".
 */
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { search } = vi.hoisted(() => ({ search: { value: "" } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

const SPACE = "33333333-3333-4333-8333-333333333333";
const query = (data: unknown) => ({
  useQuery: () => ({ data, isError: false, refetch() {} }),
});
const mutation = {
  useMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
};

vi.mock("../../../../../lib/trpc", () => ({
  POD_URL: "https://pod.example",
  trpc: {
    useUtils: () => ({}),
    grantRoles: { list: query([]) },
    profiles: {
      list: query({ profiles: [{ slug: "note", displayName: "Notes" }] }),
    },
    workspaces: {
      list: query([
        { id: "33333333-3333-4333-8333-333333333333", name: "Builder" },
      ]),
    },
    projects: { list: query({ items: [] }) },
    apiKeys: {
      create: mutation,
      createSystemKey: mutation,
      adminCreateServiceKey: mutation,
    },
  },
}));

import { KeyCreateForm } from "./key-create-form";

const render = () => renderToStaticMarkup(createElement(KeyCreateForm));

/** Each step's view, in order: closed · open · later. */
const views = (html: string) =>
  [...html.matchAll(/data-key-step="(\w+)" data-key-step-view="(\w+)"/g)].map(
    (m) => `${m[1]}:${m[2]}`
  );

/** The opening tag of the button whose content holds `text`. */
function buttonTag(html: string, text: string): string {
  const at = html.indexOf(text);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", open) + 1);
}

beforeEach(() => {
  search.value = "";
});

describe("New key: purpose first, one step open", () => {
  it("opens on Where it acts; the rest wait, and nothing below is drawn", () => {
    const html = render();
    expect(views(html)).toEqual([
      "where:open",
      "purpose:later",
      "access:later",
      "name:later",
    ]);
    // The whole matrix was the defect: no family row, no template card, no
    // name field before their step.
    expect(html).not.toContain("data-family=");
    expect(html).not.toContain("Dev loop poster");
    expect(html).not.toContain("Where will you keep it?");
    // The bar says what is still to answer, and Create waits.
    expect(html).toContain('href="#key-step-where"');
    expect(buttonTag(html, "Create API key")).toMatch(/\sdisabled(=|\s|>)/);
  });

  // Rules out: a door from a space or a link landing on step 1 again.
  it("a space and a template from the link close steps 1 to 3", () => {
    search.value = `space=${SPACE}&template=dev-loop-poster`;
    const html = render();
    expect(views(html)).toEqual([
      "where:closed",
      "purpose:closed",
      "access:closed",
      "name:open",
    ]);
    expect(html).toContain("Builder · You, in this space");
    // Step 3 closes into its families as marks, never the matrix.
    expect(html).toContain(">Activity<");
    expect(html).toContain(">Post<");
    expect(html).not.toContain("data-family=");
    expect(html).toContain("Adjust");
    expect(html).toContain('value="Dev loop poster"');
  });

  // Which templates fit which place is the shared model's
  // (`templatesForScope`, key-steps.test.ts); here, that step 2 draws them.
  it("a space from the link opens What it is for, with its cards", () => {
    search.value = `space=${SPACE}`;
    const html = render();
    expect(views(html).slice(0, 2)).toEqual(["where:closed", "purpose:open"]);
    expect(html).toContain("Dev loop poster");
    expect(html).toContain("Something else");
    // Full access is red, never a second "Full access" badge (finding 2ad1f548).
    expect(html.split(">Full access<").length - 1).toBe(1);
  });
});
