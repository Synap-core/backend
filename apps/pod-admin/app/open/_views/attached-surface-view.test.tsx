/**
 * An object's page opened on a surface (`?surface=`), rendered from the wire
 * shapes the reads answer (`surfaces.forObject`, `entities.get`):
 *
 * - the surface is gone (or hidden): the SURFACE is what is missing. The page
 *   keeps the object's own header with no "not found" mark on it, says the
 *   surface no longer exists here, and its one action opens the object by
 *   name; an untitled entity reads as its profile, never as "Entity";
 * - the surface is there: its body page draws it, with the object as the
 *   first crumb of its own trail (one way back, no second "Back to" link);
 * - the page waits for the object's name instead of renaming itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

/** What the reads answer; each test sets them. */
const read = vi.hoisted(() => ({
  surfaces: { rows: [], unavailable: [] } as unknown,
  entity: { entity: { title: "Acme deal" } } as unknown,
  entityLoading: false,
  bodies: [] as Array<{ body: string; id: string; breadcrumb: unknown }>,
  answered: (data: () => unknown, loading: () => boolean = () => false) => ({
    useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
      const off = opts?.enabled === false;
      return {
        data: off || loading() ? undefined : data(),
        error: null,
        isLoading: !off && loading(),
        refetch: () => {},
      };
    },
  }),
}));

vi.mock("../../../lib/trpc", () => ({
  trpc: {
    surfaces: { forObject: read.answered(() => read.surfaces) },
    entities: {
      get: read.answered(
        () => read.entity,
        () => read.entityLoading
      ),
    },
    focusSessions: { get: read.answered(() => undefined) },
    tracks: { get: read.answered(() => undefined) },
    playbooks: { process: read.answered(() => undefined) },
  },
}));

// The body pages are their own tested units: here, only what they are handed.
vi.mock("./view-view", () => ({
  ViewView: (p: { id: string; breadcrumb: unknown }) => {
    read.bodies.push({ body: "view", id: p.id, breadcrumb: p.breadcrumb });
    return <p>the view body</p>;
  },
}));
vi.mock("./document-view", () => ({
  DocumentView: (p: { id: string; breadcrumb: unknown }) => {
    read.bodies.push({ body: "document", id: p.id, breadcrumb: p.breadcrumb });
    return <p>the document body</p>;
  },
}));
vi.mock("./cell-view", () => ({
  CellView: (p: { id: string; breadcrumb: unknown }) => {
    read.bodies.push({ body: "cell", id: p.id, breadcrumb: p.breadcrumb });
    return <p>the cell body</p>;
  },
}));

import { AttachedSurfaceView } from "./attached-surface-view";

const E = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const S = "11111111-2222-4333-8444-555555555555";
const draw = () =>
  renderToStaticMarkup(
    <AttachedSurfaceView anchor={{ kind: "entity", id: E }} surfaceId={S} />
  );

beforeEach(() => {
  setAmbientCatalogLocale("en");
  read.surfaces = { rows: [], unavailable: [] };
  read.entity = { entity: { title: "Acme deal" } };
  read.entityLoading = false;
  read.bodies.length = 0;
});

describe("AttachedSurfaceView: a surface no longer on the object", () => {
  it("says the surface is missing, not the object, and opens the object by name", () => {
    const html = draw();
    expect(html).toContain("Acme deal");
    expect(html).toContain("This surface no longer exists here");
    expect(html).toContain(`href="/open/entity/${E}"`);
    expect(html).toContain("Open Acme deal");
    // No state mark on the object's header: the object is not missing.
    expect(html).not.toContain("Not found");
    // (the state pill's dot: any status pill on the header draws one)
    expect(html).not.toContain("bg-status-unknown");
    // The section's name is not a state.
    expect(html).not.toContain(">Surfaces<");
  });

  it("an untitled entity reads as its profile, never as Entity", () => {
    read.entity = {
      entity: { title: "  ", profileSlug: "person" },
      profile: { slug: "person", displayName: "Person" },
    };
    const html = draw();
    expect(html).toContain("Open Person");
    expect(html).not.toMatch(/\bEntity\b/);
  });

  it("an entity with no profile known reads as an item", () => {
    read.entity = { entity: { title: "" } };
    const html = draw();
    expect(html).toContain("Open Item");
    expect(html).not.toMatch(/\bEntity\b/);
  });

  it("waits for the object's name rather than renaming itself", () => {
    read.entityLoading = true;
    const html = draw();
    expect(html).not.toContain("Open ");
    expect(html).not.toContain("This surface no longer exists here");
  });
});

describe("AttachedSurfaceView: the surface is there", () => {
  const attached = (over: Record<string, unknown>) => ({
    rows: [
      {
        id: S,
        body: "view",
        relation: "attached",
        anchor: { kind: "entity", id: E },
        title: "Investor radar",
        openUrl: `/open/entity/${E}?surface=${S}`,
        readOnly: false,
        source: "attaches",
        ...over,
      },
    ],
    unavailable: [],
  });

  it("its body page draws it, the object first in its trail, no second breadcrumb", () => {
    read.surfaces = attached({});
    const html = draw();
    expect(html).toContain("the view body");
    expect(read.bodies).toEqual([
      {
        body: "view",
        id: S,
        breadcrumb: [
          { label: "Acme deal", href: `/open/entity/${E}` },
          { label: "Investor radar" },
        ],
      },
    ]);
    expect(html).not.toContain("Back to");
    expect(html).not.toContain(`href="/open/entity/${E}"`);
  });

  it("an HTML artifact opens in the document page with the same trail", () => {
    read.surfaces = attached({ body: "html", title: "" });
    draw();
    expect(read.bodies[0]).toEqual({
      body: "document",
      id: S,
      breadcrumb: [
        { label: "Acme deal", href: `/open/entity/${E}` },
        { label: "Untitled" },
      ],
    });
  });
});
