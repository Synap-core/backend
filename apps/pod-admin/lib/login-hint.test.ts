import { describe, expect, it } from "vitest";
import { loginHintFor, withLoginHint } from "./login-hint";

const flow = (...names: string[]) => ({
  ui: { nodes: names.map((name) => ({ type: "input", attributes: { name } })) },
});

describe("loginHintFor", () => {
  it("reads the hint the consent screen returns to", () => {
    expect(
      loginHintFor(
        undefined,
        "/oauth/consent?client_id=synap-desktop&login_hint=ada%40example.com"
      )
    ).toBe("ada@example.com");
  });

  it("prefers /login's own login_hint", () => {
    expect(
      loginHintFor(" bob@example.com ", "/oauth/consent?login_hint=a@x")
    ).toBe("bob@example.com");
  });

  it("ignores another page's query, and refuses a bad hint", () => {
    expect(loginHintFor(undefined, "/review?login_hint=a@x")).toBeNull();
    expect(loginHintFor(undefined, "/oauth/consent")).toBeNull();
    expect(loginHintFor("a\nb@x", "/")).toBeNull();
    expect(loginHintFor("x".repeat(255), "/")).toBeNull();
    expect(loginHintFor("   ", "/")).toBeNull();
  });
});

describe("withLoginHint", () => {
  it("fills an empty identifier field", () => {
    expect(
      withLoginHint(
        { csrf_token: "t" },
        flow("csrf_token", "identifier"),
        "a@x"
      )
    ).toEqual({ csrf_token: "t", identifier: "a@x" });
  });

  it("never overwrites what Kratos filled, nor adds a field the flow lacks", () => {
    expect(
      withLoginHint({ identifier: "kratos@x" }, flow("identifier"), "a@x")
    ).toEqual({ identifier: "kratos@x" });
    expect(withLoginHint({}, flow("traits.email"), "a@x")).toEqual({});
    expect(withLoginHint({}, flow("identifier"), null)).toEqual({});
  });
});
