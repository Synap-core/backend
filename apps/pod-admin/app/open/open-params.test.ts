import { describe, expect, it } from "vitest";
import {
  openDocumentTitle,
  openRedirect,
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
    expect(parseOpenParams("project", UUID)).toEqual({
      status: "bounce",
      type: "project",
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

  it("takes a cell's type key, colon and all, encoded or not", () => {
    // A document's cell chip links `/open/cell/<key>` (`objectPage`): a
    // `generated:` key that failed here made every such chip a dead link.
    const bounce = {
      status: "bounce",
      type: "cell",
      id: "generated:weekly-pulse",
    };
    expect(parseOpenParams("cell", "generated:weekly-pulse")).toEqual(bounce);
    expect(parseOpenParams("cell", "generated%3Aweekly-pulse")).toEqual(bounce);
    expect(parseOpenParams("cell", "generated:<x>").status).toBe("invalid-id");
    expect(parseOpenParams("cell", "generated:a/b").status).toBe("invalid-id");
  });

  it("returns not-found for an unknown type", () => {
    expect(parseOpenParams("widget", UUID)).toEqual({
      status: "not-found",
      type: "widget",
      id: UUID,
    });
  });

  it("hosts automation and session, still uuid-gated", () => {
    expect(parseOpenParams("automation", UUID).status).toBe("host");
    expect(parseOpenParams("Session", UUID)).toEqual({
      status: "host",
      type: "session",
      id: UUID,
    });
    expect(parseOpenParams("session", "not-a-uuid").status).toBe("invalid-id");
  });
});

describe("open helpers", () => {
  it("titles pages with the registry noun, not Pod Admin", () => {
    expect(openDocumentTitle(parseOpenParams("entity", UUID))).toBe("Entity");
    expect(openDocumentTitle(parseOpenParams("view", UUID))).toBe("View");
    expect(openDocumentTitle(parseOpenParams("automation", UUID))).toBe(
      "Automation"
    );
    expect(openDocumentTitle(parseOpenParams("nope", UUID))).toBe("Not found");
  });
});

describe("openRedirect", () => {
  it("sends a pod admin from a space link to the space's console page", () => {
    expect(openRedirect(parseOpenParams("workspace", UUID), true)).toBe(
      `/workspaces/${UUID}`
    );
  });

  it("leaves a member on the bounce card (the space page is pod-admin only)", () => {
    expect(openRedirect(parseOpenParams("workspace", UUID), false)).toBeNull();
  });

  it("sends a proposal link to its review page whoever asks", () => {
    expect(openRedirect(parseOpenParams("proposal", UUID), false)).toBe(
      `/proposal/${UUID}`
    );
  });

  it("draws every other kind", () => {
    for (const type of ["entity", "agent", "project", "cell", "widget"]) {
      expect(openRedirect(parseOpenParams(type, UUID), true)).toBeNull();
    }
  });
});
