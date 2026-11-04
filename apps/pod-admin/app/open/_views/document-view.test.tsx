import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";

let answer: unknown = null;
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    documents: {
      get: {
        useQuery: () => ({
          data: answer,
          error: null,
          isLoading: false,
          refetch: () => {},
        }),
      },
    },
    workspaces: { list: { useQuery: () => ({ data: [] }) } },
    useUtils: () => ({ client: {} }),
  },
}));

import { DocumentView } from "./document-view";

const doc = (content: string, canEdit: boolean) => ({
  document: {
    id: "d1",
    title: "Q3 plan",
    type: "markdown",
    size: 10,
    workspaceId: null,
    updatedAt: null,
    storageKey: "k",
    storageUrl: null,
  },
  content,
  canEdit,
});
const LIVING = ':::synap-view{id="v1"}\nfallback\n:::\n';

describe("/open/document: the header", () => {
  beforeEach(() => setAmbientCatalogLocale("en"));

  it("a living document wears a Live mark and says document, never page", () => {
    answer = doc(LIVING, false);
    const out = renderToStaticMarkup(<DocumentView id="d1" />);
    expect(out).toContain(">Live<");
    expect(out).toContain("This document is live in the Synap app");
    expect(out).not.toContain("This page is live");
  });

  it("a plain note has no Live mark and its summary comes from the catalog", () => {
    answer = doc("Just a note.", true);
    const out = renderToStaticMarkup(<DocumentView id="d1" />);
    expect(out).not.toContain(">Live<");
    expect(out).toContain("You can read it here. Edit it in the Synap app.");
  });

  it("the non-living summary follows the locale like the living one", () => {
    setAmbientCatalogLocale("fr");
    try {
      answer = doc("Just a note.", false);
      const out = renderToStaticMarkup(<DocumentView id="d1" />);
      expect(out).toContain("Vous pouvez le lire ici.");
      expect(out).not.toContain("You can read it here.");
    } finally {
      setAmbientCatalogLocale("en");
    }
  });
});
