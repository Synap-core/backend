/**
 * Every state of an object drawn by a renderer, each its own drawing:
 * loading (a skeleton for a view; a record's OWN content, never a skeleton),
 * failed (an error with Retry, never the empty card), not installed (the
 * page's own card, told so), refused (a cell that needs what the bundle
 * lacks), a partial read (`readFailed`: one quiet line), and the cell itself
 * running in the frame. A pod with no frame cell that could draw the object
 * draws exactly the page's own content, at once. Driven through the real
 * hook, resolution and frame against a fake tRPC.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CELL_MODULE_FRAME_SANDBOX } from "@synap-core/types/cell-bridge";
import type { RendererSubject } from "@synap-core/types/renderer-resolution";

type Read = { isLoading?: boolean; error?: unknown; data?: unknown };
const { reads, query } = vi.hoisted(() => {
  const reads: {
    status: Read;
    effective: Read;
    cell: Read;
    modules: Read;
    asked: string[];
  } = { status: {}, effective: {}, cell: {}, modules: {}, asked: [] };
  const query = (pick: () => Read, name?: string) => ({
    useQuery: (input: unknown) => {
      if (name) reads.asked.push(`${name}:${JSON.stringify(input)}`);
      return {
        isLoading: false,
        error: null,
        data: undefined,
        refetch: () => {},
        ...pick(),
      };
    },
  });
  return { reads, query };
});

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ client: {} }),
    renderers: {
      status: query(() => reads.status),
      hostModules: query(() => reads.modules),
    },
    profiles: { getEffectiveRenderers: query(() => reads.effective) },
    widgetDefinitions: { get: query(() => reads.cell, "cell") },
  },
}));

import {
  ModuleCell,
  RenderedObject,
  RendererNotice,
  type FallbackContext,
} from "./rendered-object";
import { forgetHostModules } from "./use-host-modules";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const iframes = (m: string) => m.match(/<iframe\b[^>]*>/gi) ?? [];

const BOARD = "cell:synap-renderers:board";
const VIEW = "22222222-2222-4222-8222-222222222222";
const STATUS = {
  bundle: {
    slug: "synap-renderers",
    version: "1",
    setSha256: "s1",
    reactVersion: "19.2.3",
  },
  defaults: { views: { board: "board" } },
  installed: [
    {
      key: BOARD,
      runtime: "frame",
      contentKind: "collection",
      viewTypes: ["board"],
    },
  ],
};
const MODULES = {
  notModified: false,
  setSha256: "s1",
  modules: {
    react: "r",
    reactDom: "rd",
    reactDomClient: "rdc",
    jsxRuntime: "jsx",
    tokensCss: ":root{}",
  },
  kitExports: [],
};
const CELL = {
  typeKey: BOARD,
  rendererType: "frame",
  rendererSource: "export default function Board() { return null; }",
  workspaceId: "ws-1",
};
const board: RendererSubject = {
  kind: "view",
  viewId: VIEW,
  viewType: "board",
};
const FALLBACK = <p>IDENTITY-CARD</p>;
const told = ({ notInstalled }: FallbackContext) => (
  <p>IDENTITY-CARD{notInstalled ? " NOT-INSTALLED" : ""}</p>
);

function draw(subject = board) {
  return html(
    <RenderedObject
      subject={subject}
      workspaceId="ws-1"
      title="Pipeline"
      fill
      fallback={told}
    />
  );
}

const ENTITY = "11111111-1111-4111-8111-111111111111";
const detail: RendererSubject = {
  kind: "entity",
  slot: "entity-detail",
  entityId: ENTITY,
  profileSlug: "deal",
};
const drawRecord = (subject: RendererSubject = detail) =>
  html(
    <RenderedObject
      subject={subject}
      workspaceId="ws-1"
      title="Acme"
      fallback={FALLBACK}
    />
  );

beforeEach(() => {
  forgetHostModules();
  reads.status = { data: STATUS };
  reads.effective = {};
  reads.cell = { data: CELL };
  reads.modules = { data: MODULES };
  reads.asked = [];
});

describe("RenderedObject — each state", () => {
  it("draws the resolved cell in the module frame", () => {
    const out = draw();
    const frames = iframes(out);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain(`sandbox="${CELL_MODULE_FRAME_SANDBOX}"`);
    expect(out).not.toContain("IDENTITY-CARD");
  });

  it("loading is a skeleton in the frame's shape, not the card", () => {
    reads.status = { isLoading: true };
    const out = draw();
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Drawing this view…");
    expect(out).not.toContain("IDENTITY-CARD");
    expect(iframes(out)).toHaveLength(0);
  });

  it("a failed status read is an error with Retry (and the page's door), never empty", () => {
    reads.status = { error: { data: { code: "INTERNAL_SERVER_ERROR" } } };
    const out = draw();
    expect(out).toContain("Couldn’t draw this view");
    expect(out).toContain("Retry");
    expect(out).toContain("IDENTITY-CARD");
    expect(iframes(out)).toHaveLength(0);
  });

  it("not installed: the page's card, told so (never a pill above it)", () => {
    reads.status = { data: { bundle: null, defaults: {}, installed: [] } };
    const out = draw();
    expect(out).toContain("IDENTITY-CARD NOT-INSTALLED");
    expect(out).not.toContain("Not drawn");
    expect(iframes(out)).toHaveLength(0);
    // Not asked for a source it could never run.
    expect(reads.asked).toEqual([]);
  });

  it("a binding to a cell this pod cannot run as a frame keeps the card, unread", () => {
    // The kind's binding names the desktop's own task detail: resolved, but
    // not one of this pod's frame cells.
    reads.effective = {
      data: {
        "entity-detail": {
          kind: "cell",
          cellKey: "entity-detail-task",
          props: {},
        },
        sources: { "entity-detail": "profile" },
      },
    };
    const out = draw({
      kind: "entity",
      slot: "entity-detail",
      entityId: ENTITY,
      profileSlug: "task",
    });
    expect(out).toContain("IDENTITY-CARD");
    expect(iframes(out)).toHaveLength(0);
    expect(reads.asked).toEqual([]);
  });

  it("a cell whose source read failed is an error, not the card", () => {
    reads.cell = { error: { data: { code: "INTERNAL_SERVER_ERROR" } } };
    const out = draw();
    expect(out).toContain("Couldn’t draw this view");
    expect(out).not.toContain("IDENTITY-CARD");
  });

  it("the bundle's modules failing to read is an error with Retry", () => {
    reads.modules = { error: { data: { code: "INTERNAL_SERVER_ERROR" } } };
    const out = draw();
    expect(out).toContain("Couldn’t draw this view");
    expect(out).toContain("Retry");
    expect(iframes(out)).toHaveLength(0);
  });

  it("a partial read (the bindings failed) is one quiet line, never an error row", () => {
    reads.effective = { error: { data: { code: "INTERNAL_SERVER_ERROR" } } };
    const out = drawRecord({ ...detail, slot: "entity-card" });
    expect(out).toContain(
      "Showing the default: couldn’t read this kind’s choice."
    );
    expect(out).not.toContain("Couldn’t draw");
    expect(out).not.toContain("Retry");
    expect(out).toContain("IDENTITY-CARD");
  });
});

describe("a record's slot never waits on a renderer that cannot come", () => {
  it("no frame cell on this pod: exactly the page's own content, at once", () => {
    reads.status = { data: { bundle: null, defaults: {}, installed: [] } };
    // The bindings read would still be in flight: nothing waits on it.
    reads.effective = { isLoading: true };
    for (const slot of ["entity-detail", "entity-card"] as const) {
      expect(drawRecord({ ...detail, slot })).toBe("<p>IDENTITY-CARD</p>");
    }
  });

  it("while the reads load, a record draws its own content, never a skeleton", () => {
    reads.status = { isLoading: true };
    expect(drawRecord()).toBe("<p>IDENTITY-CARD</p>");
    reads.status = { data: STATUS };
    reads.effective = { isLoading: true };
    expect(drawRecord()).toBe("<p>IDENTITY-CARD</p>");
  });

  it("a view type no installed cell declares is its card at once", () => {
    const out = draw({ kind: "view", viewId: VIEW, viewType: "calendar" });
    expect(out).toBe("<p>IDENTITY-CARD</p>");
  });

  it("a cell that resolves starts hidden under the record's own content", () => {
    reads.effective = {
      data: {
        "entity-detail": { kind: "cell", cellKey: BOARD, props: {} },
        sources: { "entity-detail": "profile" },
      },
    };
    const out = drawRecord();
    expect(out).toContain("IDENTITY-CARD");
    expect(out).not.toContain('aria-busy="true"');
    const frames = iframes(out);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('aria-hidden="true"');
  });
});

describe("ModuleCell — refused and not installed", () => {
  const source = {
    code: 'import { Card } from "@synap/kit";\nexport default function C() { return null; }',
    workspaceId: "ws-1",
  };

  it("refused: a cell that needs the kit this bundle lacks says so, with its door", () => {
    const out = html(
      <ModuleCell
        source={source}
        identity={{ typeKey: "generated:card" }}
        title="Card"
        door={<a href="/open/cell/x">DOOR</a>}
      />
    );
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain("This needs parts this pod doesn’t have.");
    expect(out).toContain("DOOR");
  });

  it("not installed: NOT_FOUND from the bundle says so, with its door", () => {
    reads.modules = { error: { data: { code: "NOT_FOUND" } } };
    const out = html(
      <ModuleCell
        source={{ ...source, code: CELL.rendererSource }}
        identity={{ typeKey: "generated:card" }}
        title="Card"
        door={<a href="/open/cell/x">DOOR</a>}
      />
    );
    expect(out).toContain("Synap’s renderers aren’t on this pod.");
    expect(out).toContain("DOOR");
  });
});

describe("RendererNotice", () => {
  it("says the renderers are not on this pod, beside its door", () => {
    const out = html(<RendererNotice action={<a href="/x">DOOR</a>} />);
    expect(out).toContain("Synap’s renderers aren’t on this pod.");
    expect(out).toContain("DOOR");
  });
});
