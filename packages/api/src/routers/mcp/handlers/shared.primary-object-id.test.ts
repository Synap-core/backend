import { describe, it, expect } from "vitest";
import { ok } from "./shared.js";

function payload(result: ReturnType<typeof ok>) {
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error("ok() did not return a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe("ok() injects link from primaryObjectId wrappers", () => {
  it("unwraps view like document/channel so create_view gets a clickable link", () => {
    const created = payload(
      ok({
        view: { id: "view-abc" },
        documentId: null,
        status: "created",
      })
    );
    expect(created.link).toEqual(expect.stringMatching(/\/open\/view-abc$/));
    expect(created).not.toHaveProperty("openUrl");
  });

  it("prefers the created view over a canvas backing documentId", () => {
    const created = payload(
      ok({
        view: { id: "view-canvas" },
        documentId: "doc-backing",
        status: "created",
      })
    );
    expect(created.link).toEqual(expect.stringMatching(/\/open\/view-canvas$/));
  });

  it("unwraps document and channel wrappers", () => {
    expect(payload(ok({ document: { id: "doc-1" } })).link).toEqual(
      expect.stringMatching(/\/open\/doc-1$/)
    );
    expect(payload(ok({ channel: { id: "ch-1" } })).link).toEqual(
      expect.stringMatching(/\/open\/ch-1$/)
    );
  });
});
