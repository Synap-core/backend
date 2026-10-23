import { describe, expect, it } from "vitest";
import {
  loginHintFor,
  signInAgainReason,
  withLoginHint,
  withoutFederatedSignIn,
} from "./login-hint";

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

describe("signInAgainReason", () => {
  it("names the Synap app whose consent asked to confirm it's you", () => {
    expect(
      signInAgainReason("/oauth/consent?client_id=synap-desktop&prompt=login")
    ).toBe("Synap Desktop asks you to confirm it's you.");
    expect(signInAgainReason("/oauth/consent?client_id=dcr_x")).toBe(
      "An app asks you to confirm it's you."
    );
  });

  it("keeps the console's own reason elsewhere", () => {
    expect(signInAgainReason("/settings/security")).toBe(
      "Sign in again to change your security settings."
    );
  });
});

describe("withoutFederatedSignIn", () => {
  it("drops the federated (oidc) methods and keeps the password form", () => {
    const flow = {
      id: "f",
      ui: {
        nodes: [
          { group: "default", attributes: { name: "csrf_token" } },
          { group: "password", attributes: { name: "password" } },
          { group: "oidc", attributes: { name: "provider" } },
        ],
      },
    };
    const out = withoutFederatedSignIn(flow);
    expect(out.ui.nodes.map((n) => n.group)).toEqual(["default", "password"]);
    expect(out.id).toBe("f");
    expect(flow.ui.nodes).toHaveLength(3);
  });
});
