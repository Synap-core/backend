import { describe, expect, it } from "vitest";
import { NAV_COLLAPSED_ATTR, navCollapsedScript } from "./nav-collapsed";

/** Run the inline script against a stub storage and `<html>`. */
function run(storage: { getItem: (k: string) => string | null }) {
  const attrs = new Set<string>();
  const documentStub = {
    documentElement: { setAttribute: (name: string) => attrs.add(name) },
  };
  new Function("localStorage", "document", navCollapsedScript())(
    storage,
    documentStub
  );
  return attrs;
}

describe("navCollapsedScript", () => {
  it("marks <html> when the nav was collapsed", () => {
    expect(run({ getItem: () => "1" }).has(NAV_COLLAPSED_ATTR)).toBe(true);
  });

  it("leaves it wide otherwise", () => {
    expect(run({ getItem: () => "0" }).size).toBe(0);
    expect(run({ getItem: () => null }).size).toBe(0);
  });

  it("survives storage that throws", () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
    };
    expect(() => run(throwing)).not.toThrow();
  });
});
