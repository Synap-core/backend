/**
 * The Surfaces list on an object's page, rendered from the wire
 * shape `surfaces.forObject` answers: each row a door (an attached surface
 * opens this page on it, `?surface=`) with a ⋯ menu, the body and the detail
 * look not listed again, a row that opens nowhere not listed, nothing drawn
 * while the read is in flight or when there is nothing, a failed read (or a
 * failed store with nothing listed) said with its retry, and a failed store
 * beside listed rows said in one line under them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

type Read = {
  isLoading?: boolean;
  isError?: boolean;
  data?: unknown;
};
let read: Read = {};
const asked: Array<{ kind: string; id: string }> = [];

vi.mock("../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ surfaces: { forObject: { invalidate: vi.fn() } } }),
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
      detach: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
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
  setAmbientCatalogLocale("en");
});
afterEach(() => setAmbientCatalogLocale("en"));

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
          // The page's own look, attached in the detail slot: worn, not listed.
          row({
            id: "44444444-2222-4333-8444-555555555555",
            body: "cell",
            relation: "attached",
            slot: "detail",
            title: "Its own look",
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
    expect(html).not.toContain("Its own look");
    // Each body named through the vocabulary door.
    expect(html).toContain(">HTML artifact<");
    expect(html).toContain(">View<");
    // Each row carries its ⋯ menu, named for the row.
    expect(html).toContain('aria-label="Actions for Investor radar"');
    expect(html).toContain('aria-label="Actions for Deck"');
  });

  it("does not list a row that opens nowhere here (named, not a door)", () => {
    read = {
      data: {
        rows: [
          row({}),
          // A space's start-page cell: no page here, no outside link.
          row({
            id: "home-cell",
            body: "cell",
            relation: "home",
            title: "Start cell",
            source: "start-page",
            openUrl: `/open/${E}`,
          }),
        ],
        unavailable: [],
      },
    };
    const html = draw();
    expect(html).toContain(">Investor radar<");
    expect(html).not.toContain("Start cell");
  });

  it("names each body in the reader's language", () => {
    setAmbientCatalogLocale("fr");
    read = { data: { rows: [row({})], unavailable: [] } };
    const html = draw();
    expect(html).toContain(">Vue<");
    expect(html).not.toContain(">View<");
  });

  it("caps the list; Show all says it is collapsed", () => {
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
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*aria-expanded="false"[^>]*>Show all ${SURFACES_CAP + 2}`
      )
    );
  });

  it("draws nothing while the read is in flight (no card that then vanishes)", () => {
    read = { isLoading: true, data: undefined };
    expect(draw()).toBe("");
  });

  it("says a failed read, with a retry, never an empty list", () => {
    read = { isError: true, data: undefined };
    const html = draw();
    expect(html).toContain("Couldn’t load surfaces");
    expect(html).toMatch(/<button[^>]*>[^<]*Retry/);
  });

  it("a failed store with nothing listed is a failed read, never a short list", () => {
    read = {
      data: { rows: [], unavailable: [{ source: "views", error: "boom" }] },
    };
    const html = draw();
    expect(html).toContain("Couldn’t load surfaces");
    expect(html).not.toContain("Some surfaces couldn’t be loaded");
    expect(html).toMatch(/<button[^>]*>[^<]*Retry/);
  });

  it("a failed store beside listed rows is one line under them, with its retry", () => {
    read = {
      data: {
        rows: [row({})],
        unavailable: [{ source: "views", error: "boom" }],
      },
    };
    const html = draw();
    expect(html).toContain(">Investor radar<");
    expect(html).toContain("Some surfaces couldn’t be loaded.");
    expect(html).not.toContain("Couldn’t load surfaces");
    const strip = html.slice(html.indexOf("Some surfaces couldn"));
    expect(strip).toMatch(/<button[^>]*>[^<]*Retry/);
  });

  it("draws nothing when the object carries nothing", () => {
    read = { data: { rows: [], unavailable: [] } };
    expect(draw()).toBe("");
  });
});
