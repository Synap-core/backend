/**
 * `/open/cell/<key>`: a module cell runs in the module frame, a page cell in
 * the page frame, any other cell is named and handed to the app; a cell not
 * visible to the reader is "not found", and a failed read is a failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import {
  CELL_FRAME_SANDBOX,
  CELL_MODULE_FRAME_SANDBOX,
} from "@synap-core/types/cell-bridge";

const { reads } = vi.hoisted(() => ({
  reads: {
    cell: {} as { data?: unknown; error?: unknown },
    modules: {} as { data?: unknown; error?: unknown },
  },
}));
vi.mock("../../../lib/trpc", () => {
  const answered = (pick: () => { data?: unknown; error?: unknown }) => ({
    useQuery: () => ({
      isLoading: false,
      error: null,
      data: undefined,
      refetch: () => {},
      ...pick(),
    }),
  });
  return {
    trpc: {
      useUtils: () => ({ client: {} }),
      // The frame's context (contract v3): none to wear here.
      surfaces: { context: { useQuery: () => ({ data: { brand: null } }) } },
      widgetDefinitions: { get: answered(() => reads.cell) },
      renderers: { hostModules: answered(() => reads.modules) },
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/open/cell/x",
  useSearchParams: () => new URLSearchParams(),
}));

import { CellView, cellTitle } from "./cell-view";

const KEY = "generated:deal-card";
const frames = (m: string) => m.match(/<iframe\b[^>]*>/gi) ?? [];
const draw = () => renderToStaticMarkup(<CellView id={KEY} />);

beforeEach(() => {
  setAmbientCatalogLocale("en");
  reads.modules = {
    data: {
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
    },
  };
});

describe("/open/cell/<key>", () => {
  it("a module cell runs in the module frame, under its name", () => {
    reads.cell = {
      data: {
        typeKey: KEY,
        name: "Deal card",
        rendererType: "frame",
        rendererSource: "export default function C() { return null; }",
      },
    };
    const out = draw();
    expect(frames(out)).toHaveLength(1);
    expect(frames(out)[0]).toContain(`sandbox="${CELL_MODULE_FRAME_SANDBOX}"`);
    expect(out).toContain("Deal card");
  });

  it("a page cell runs in the page frame", () => {
    reads.cell = {
      data: {
        typeKey: KEY,
        name: "Report",
        rendererType: "iframe",
        rendererSource: "<!doctype html><p>hi</p>",
      },
    };
    const out = draw();
    expect(frames(out)).toHaveLength(1);
    expect(frames(out)[0]).toContain(`sandbox="${CELL_FRAME_SANDBOX}"`);
  });

  it("a cell only the app draws is named and handed to the app", () => {
    reads.cell = {
      data: { typeKey: KEY, name: "Deal list", rendererType: "builtin" },
    };
    const out = draw();
    expect(frames(out)).toHaveLength(0);
    expect(out).toContain("Deal list");
    expect(out).toContain("Open it in the Synap app.");
  });

  it("not visible (the pod answers null) is not found", () => {
    reads.cell = { data: null };
    expect(draw()).toContain("couldn’t be found");
  });

  it("a failed read is a failure, never 'not found'", () => {
    reads.cell = { error: { data: { code: "INTERNAL_SERVER_ERROR" } } };
    const out = draw();
    expect(out).toContain("couldn’t be loaded");
    expect(out).not.toContain("couldn’t be found");
  });

  it("a cell with no name is named from its key", () => {
    expect(cellTitle("cell:crm:deal-board", {})).toBe("Deal board");
  });
});
