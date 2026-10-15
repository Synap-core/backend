import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./safe-return-to";

/** A result is safe when it is a path the browser keeps on this origin. */
function staysHome(result: string): boolean {
  return (
    result.startsWith("/") &&
    !result.startsWith("//") &&
    new URL(result, "https://pod.example").origin === "https://pod.example"
  );
}

describe("safeReturnTo", () => {
  it("keeps an in-app path with its query and hash", () => {
    expect(safeReturnTo("/review?x=1")).toBe("/review?x=1");
    expect(safeReturnTo("/audit?focus=a#row")).toBe("/audit?focus=a#row");
  });

  it("falls back to the root for nothing, a relative path, or /login", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("review")).toBe("/");
    expect(safeReturnTo("/login")).toBe("/");
    expect(safeReturnTo("/login?return=/x")).toBe("/");
  });

  it.each([
    "//evil.com",
    "https://evil.com",
    // As Next hands them over: already percent-decoded.
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
  ])("refuses %j", (raw) => {
    expect(safeReturnTo(raw)).toBe("/");
  });

  it.each(["/%5Cevil.com", "/%09/evil.com", "/%2F%2Fevil.com"])(
    "keeps %j on this origin when it arrives still encoded",
    (raw) => {
      expect(staysHome(safeReturnTo(raw))).toBe(true);
    }
  );
});
