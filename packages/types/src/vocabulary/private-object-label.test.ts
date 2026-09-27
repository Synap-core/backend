import { describe, it, expect } from "vitest";
import {
  resolveMembersDecideLabel,
  resolvePrivateObjectLabel,
  resolveObjectNoun,
} from "./index.js";

describe("resolvePrivateObjectLabel (decision D1 placeholder)", () => {
  it("names a withheld session without its title", () => {
    expect(resolvePrivateObjectLabel("focus_session")).toBe("Private session");
    expect(resolvePrivateObjectLabel("session")).toBe("Private session");
  });

  it("derives the noun from the one noun door, never a second table", () => {
    const noun = resolveObjectNoun("focus_session");
    expect(resolvePrivateObjectLabel("focus_session")).toBe(
      `Private ${noun.toLowerCase()}`
    );
  });

  it("keeps an acronym noun intact and never leaks a raw token", () => {
    expect(resolvePrivateObjectLabel("api_key")).toBe(
      `Private ${resolveObjectNoun("api_key")}`
    );
    expect(resolvePrivateObjectLabel(undefined)).toBe("Private item");
  });
});

describe("resolveMembersDecideLabel (decision 2026-09-27 decide gate)", () => {
  it("names who may decide, from the one noun door", () => {
    expect(resolveMembersDecideLabel("focus_session")).toBe(
      "Session members decide"
    );
    expect(resolveMembersDecideLabel("focus_session")).toBe(
      `${resolveObjectNoun("focus_session")} members decide`
    );
    expect(resolveMembersDecideLabel(undefined)).toBe("Item members decide");
  });
});
