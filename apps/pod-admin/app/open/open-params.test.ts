import { describe, expect, it } from "vitest";
import {
  openDocumentTitle,
  openInAppHref,
  parseOpenParams,
} from "./open-params";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseOpenParams", () => {
  it("hosts entity and view when the id is a UUID", () => {
    expect(parseOpenParams("entity", UUID)).toEqual({
      status: "host",
      type: "entity",
      id: UUID,
    });
    expect(parseOpenParams("VIEW", UUID)).toEqual({
      status: "host",
      type: "view",
      id: UUID,
    });
  });

  it("rejects a non-UUID host id without fetching", () => {
    expect(parseOpenParams("entity", "not-a-uuid")).toEqual({
      status: "invalid-id",
      type: "entity",
      id: "not-a-uuid",
    });
  });

  it("marks known bounce kinds (safe id) for the app deep link", () => {
    expect(parseOpenParams("channel", UUID)).toEqual({
      status: "bounce",
      type: "channel",
      id: UUID,
    });
    expect(parseOpenParams("proposal", UUID)).toEqual({
      status: "bounce",
      type: "proposal",
      id: UUID,
    });
  });

  it("rejects an unsafe bounce id", () => {
    expect(parseOpenParams("cell", "bad id")).toEqual({
      status: "invalid-id",
      type: "cell",
      id: "bad id",
    });
  });

  it("returns not-found for an unknown type", () => {
    expect(parseOpenParams("widget", UUID)).toEqual({
      status: "not-found",
      type: "widget",
      id: UUID,
    });
  });
});

describe("open helpers", () => {
  it("titles host pages Entity / View, not Pod Admin", () => {
    expect(openDocumentTitle(parseOpenParams("entity", UUID))).toBe("Entity");
    expect(openDocumentTitle(parseOpenParams("view", UUID))).toBe("View");
    expect(openDocumentTitle(parseOpenParams("nope", UUID))).toBe("Not found");
  });

  it("builds the desktop/phone deep link", () => {
    expect(openInAppHref("entity", UUID)).toBe(`synap://open/entity/${UUID}`);
  });
});
