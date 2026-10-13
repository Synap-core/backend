import { describe, expect, it } from "vitest";
import { couldNotLoad, loadFailure, notFound } from "./load-failure";

const err = (code: string) => ({ data: { code } });

describe("loadFailure", () => {
  it("speaks in the registry noun, lowercased", () => {
    expect(loadFailure(err("NOT_FOUND"), "Rule")?.title).toBe(
      "This rule couldn’t be found"
    );
    expect(loadFailure(err("FORBIDDEN"), "Session")?.chip).toBe("No access");
    expect(loadFailure(err("BOOM"), "View")?.chip).toBe("Couldn’t load");
  });

  it("is null without an error", () => {
    expect(loadFailure(null, "Entity")).toBeNull();
  });

  it("offers the Synap app by default", () => {
    expect(loadFailure(err("NOT_FOUND"), "Rule")?.message).toMatch(/Synap app/);
    expect(couldNotLoad("Rule").message).toMatch(/Synap app/);
  });

  it("never sends the reader to the Synap app for an object it has no page for", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "INTERNAL_SERVER_ERROR"]) {
      expect(
        loadFailure(err(code), "Computer", { inApp: false })?.message
      ).not.toMatch(/Synap app/);
    }
    expect(notFound("Computer", { inApp: false }).message).not.toMatch(
      /Synap app/
    );
  });

  it("takes a page's own not-found and no-access sentences, keeping titles and chips", () => {
    const wording = {
      inApp: false,
      notFound: "Every app still connected is on the Apps list.",
      forbidden: "An app's page is for pod admins.",
    };
    expect(loadFailure(err("NOT_FOUND"), "App", wording)).toEqual({
      title: "This app couldn’t be found",
      message: wording.notFound,
      chip: "Not found",
    });
    expect(loadFailure(err("FORBIDDEN"), "App", wording)?.message).toBe(
      wording.forbidden
    );
    expect(loadFailure(err("UNAUTHORIZED"), "App", wording)?.chip).toBe(
      "Sign in required"
    );
  });
});
