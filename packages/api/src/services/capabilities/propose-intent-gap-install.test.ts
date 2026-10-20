import { beforeEach, describe, expect, it, vi } from "vitest";

const createPendingProposal = vi.fn();
vi.mock("../../utils/permission-check.js", () => ({
  createPendingProposal: (...args: unknown[]) => createPendingProposal(...args),
}));
vi.mock("../../utils/deep-links.js", () => ({
  openLink: (id: string) => `/open/${id}`,
}));

import { proposeIntentGapInstall } from "./propose-intent-gap-install.js";

describe("proposeIntentGapInstall — the row the approve executor pins", () => {
  beforeEach(() => {
    createPendingProposal.mockReset();
    createPendingProposal.mockResolvedValue({ id: "p-1" });
  });

  it("names the official source and the listing it proposed", async () => {
    const offer = await proposeIntentGapInstall({
      intent: "generate_media",
      candidates: [
        {
          slug: "media-pack",
          name: "Media pack",
          description: null,
          version: "1.2.0",
          listingSha256: "abc123",
        },
      ],
      userId: "u-1",
      workspaceId: "w-1",
    });

    expect(offer.status).toBe("proposed");
    const data = createPendingProposal.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      slug: "media-pack",
      kind: "capability",
      source: "synap",
      listingSha256: "abc123",
    });
  });

  it("stamps a null digest for an official entry with no listing", async () => {
    await proposeIntentGapInstall({
      intent: "generate_media",
      candidates: [
        {
          slug: "media-pack",
          name: "Media pack",
          description: null,
          version: null,
          listingSha256: null,
        },
      ],
      userId: "u-1",
      workspaceId: null,
    });

    const data = createPendingProposal.mock.calls[0]![0].data;
    expect(data.source).toBe("synap");
    expect(data.listingSha256).toBeNull();
  });
});
