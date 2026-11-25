/**
 * A catalog card with no description draws no description line: absent is
 * omitted, a placeholder sentence is not a state (ui-composition). Rendered
 * with react-dom/server (pod-admin's vitest has no DOM).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));
// The sources tab pulls the presence door, which needs a built @synap-core/types.
vi.mock("./sources-tab", () => ({ TrustChip: () => null }));

import { EntryCard } from "./catalog-tab";
import type { CatalogEntry } from "./types";

function entry(description: string | null): CatalogEntry {
  return {
    id: "apify",
    name: "Apify — Actor Platform",
    objectKind: "capability",
    description,
    sourceName: "Synap",
    trust: "official",
  } as unknown as CatalogEntry;
}

describe("EntryCard", () => {
  it("omits the description line when the package has none", () => {
    const html = renderToStaticMarkup(
      <EntryCard entry={entry(null)} showSource={false} />
    );
    expect(html).toContain("Apify — Actor Platform");
    expect(html).not.toContain("No description");
    expect(html).not.toContain("line-clamp-2");
  });

  it("still draws a real description", () => {
    const html = renderToStaticMarkup(
      <EntryCard
        entry={entry("Run web scrapers and crawlers.")}
        showSource={false}
      />
    );
    expect(html).toContain("Run web scrapers and crawlers.");
  });
});
