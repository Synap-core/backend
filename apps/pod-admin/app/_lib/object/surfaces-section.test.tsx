/**
 * The Surfaces list on an object's page (Surfaces P3), rendered from the wire
 * shape `surfaces.forObject` answers: each row a door (an attached surface
 * opens this page on it, `?surface=`), the body and the detail look not
 * listed again, a failed read said with its retry, a partial read said, and
 * nothing drawn when there is nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Read = {
  isLoading?: boolean;
  isError?: boolean;
  data?: unknown;
};
let read: Read = {};
const asked: Array<{ kind: string; id: string }> = [];

vi.mock("../../../lib/trpc", () => ({
  trpc: {
    surfaces: {
      forObject: {
        useQuery: (input: { kind: string; id: string }) => {
          asked.push(input);
          return {
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
            ...read,
          };
        },
      },
    },
  },
}));

import { SurfacesSection } from "./surfaces-section";
import { SURFACES_CAP } from "./surfaces-model";

const E = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const anchor = { kind: "entity" as const, id: E };
const row = (over: Record<string, unknown>) => ({
  id: "11111111-2222-4333-8444-555555555555",
  body: "view",
  relation: "attached",
  anchor,
  title: "Investor radar",
  viewType: "table",
  openUrl: `/open/entity/${E}?surface=11111111-2222-4333-8444-555555555555`,
  readOnly: false,
  source: "attaches",
  ...over,
});
const draw = () => renderToStaticMarkup(<SurfacesSection anchor={anchor} />);

beforeEach(() => {
  read = {};
  asked.length = 0;
});

describe("SurfacesSection", () => {
  it("lists the surfaces, each a door; an attached one opens this page on it", () => {
    read = {
      data: {
        rows: [
          row({}),
          row({
            id: "22222222-2222-4333-8444-555555555555",
            body: "html",
            relation: "pinned",
            title: "Deck",
            source: "views",
            openUrl: "/open/22222222-2222-4333-8444-555555555555",
          }),
          // The body and the detail look are already on the page.
          row({
            id: "33333333-2222-4333-8444-555555555555",
            relation: "body",
            title: "The body",
          }),
          row({
            id: "task-card",
            body: "cell",
            relation: "renders",
            title: "Kind look",
          }),
        ],
        unavailable: [],
      },
    };
    const html = draw();
    expect(asked[0]).toEqual({ kind: "entity", id: E });
    expect(html).toContain("Surfaces");
    expect(html).toContain(
      `href="/open/entity/${E}?surface=11111111-2222-4333-8444-555555555555"`
    );
    expect(html).toContain(">Investor radar<");
    expect(html).toContain(">Deck<");
    expect(html).toContain(
      'href="/open/document/22222222-2222-4333-8444-555555555555"'
    );
    expect(html).not.toContain("The body");
    expect(html).not.toContain("Kind look");
  });

  it("caps the list and offers Show all", () => {
    read = {
      data: {
        rows: Array.from({ length: SURFACES_CAP + 2 }, (_, i) =>
          row({
            id: `0000000${i}-2222-4333-8444-555555555555`,
            title: `Board ${i}`,
          })
        ),
        unavailable: [],
      },
    };
    const html = draw();
    expect(html).toContain(`Board ${SURFACES_CAP - 1}`);
    expect(html).not.toContain(`Board ${SURFACES_CAP}<`);
    expect(html).toContain(`Show all ${SURFACES_CAP + 2}`);
  });

  it("says a failed read, with a retry, never an empty list", () => {
    read = { isError: true, data: undefined };
    const html = draw();
    expect(html).toContain("couldn’t be read");
  });

  it("says when a store could not be read, even with no rows", () => {
    read = {
      data: { rows: [], unavailable: [{ source: "views", error: "boom" }] },
    };
    expect(draw()).toContain("Some places couldn’t be read");
  });

  it("draws nothing when the object carries nothing", () => {
    read = { data: { rows: [], unavailable: [] } };
    expect(draw()).toBe("");
  });
});
