import { describe, expect, it } from "vitest";

import { buildCellRendererRef } from "./profiles.js";

describe("profile renderer refs", () => {
  it("keeps generated frame typeKeys as direct cell registry keys", () => {
    expect(
      buildCellRendererRef(
        "generated:contact-card",
        { density: "compact" },
        "frame"
      )
    ).toEqual({
      kind: "cell",
      cellKey: "generated:contact-card",
      props: { density: "compact" },
    });
  });

  it("keeps sandboxed definitions behind the iframe host", () => {
    expect(
      buildCellRendererRef("contact-card", { density: "compact" }, "iframe")
    ).toEqual({
      kind: "cell",
      cellKey: "iframe-widget",
      props: { typeKey: "contact-card", density: "compact" },
    });
  });
});
