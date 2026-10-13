import { describe, expect, it } from "vitest";
import { appLoadFailure } from "./app-load-failure";

const err = (code: string) => ({ data: { code } });

describe("appLoadFailure", () => {
  it("never sends the reader to the Synap app — an app's page is only here", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "INTERNAL_SERVER_ERROR"]) {
      expect(appLoadFailure(err(code)).message).not.toMatch(/Synap app/);
    }
  });

  it("keeps the shared titles and chips", () => {
    expect(appLoadFailure(err("NOT_FOUND"))).toMatchObject({
      title: "This app couldn’t be found",
      chip: "Not found",
    });
    expect(appLoadFailure(err("UNAUTHORIZED")).chip).toBe("Sign in required");
    expect(appLoadFailure(null).chip).toBe("Couldn’t load");
  });
});
