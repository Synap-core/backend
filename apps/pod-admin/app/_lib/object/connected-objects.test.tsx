import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let answer: { isLoading: boolean; error: unknown; data: unknown } = {
  isLoading: false,
  error: null,
  data: { entities: [] },
};
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ client: {} }),
    relations: {
      getRelated: { useQuery: () => ({ ...answer, refetch: vi.fn() }) },
    },
    documents: { get: { useQuery: () => ({ isLoading: true, error: null }) } },
  },
}));
vi.mock("../media/use-stored-media", () => ({
  useStoredMedia: () => ({ state: "loading" }),
}));

import { ConnectedObjects } from "./connected-objects";

const SELF = "8d6d5a59-16b8-4d33-a4de-8499487e104c";
const draw = () => renderToStaticMarkup(<ConnectedObjects entityId={SELF} />);

describe("ConnectedObjects", () => {
  it("draws an asset's related files: images as captioned doors, other objects as doors", () => {
    answer = {
      isLoading: false,
      error: null,
      data: {
        entities: [
          {
            id: "a",
            title: "quote-card-169.png",
            type: "file",
            documentId: "d1",
            properties: { mimeType: "image/png" },
          },
          { id: "c", title: "Brand voice", type: "brand-voice-guide" },
        ],
      },
    };
    const html = draw();
    expect(html).toContain('href="/open/entity/a"');
    expect(html).toContain("quote-card-169.png");
    expect(html).toContain('href="/open/entity/c"');
    expect(html).toContain("Brand voice");
  });

  it("says a failed read failed, never 'nothing connected'", () => {
    answer = { isLoading: false, error: new Error("x"), data: undefined };
    expect(draw()).toContain("couldn’t be read");
  });

  it("is omitted with no neighbours", () => {
    answer = { isLoading: false, error: null, data: { entities: [] } };
    expect(draw()).toBe("");
  });
});
