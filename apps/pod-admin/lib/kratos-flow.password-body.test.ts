/**
 * `passwordLoginBody`: the invite page signs a just-created account in by
 * code. A pod that offers Synap Cloud and passkeys renders their method nodes
 * in the same flow; their values must not ride along, or Kratos routes the
 * submit to that method and the new account is left signed out.
 */
import { describe, expect, it } from "vitest";
import { passwordLoginBody, type KratosFlow } from "./kratos-flow";

const node = (
  name: string,
  type: string,
  value: string,
  group = "default"
) => ({
  type: "input",
  group,
  attributes: { name, type, value },
});

const FLOW = {
  id: "f1",
  ui: {
    action: "https://pod.example.com/self-service/login?flow=f1",
    method: "POST",
    nodes: [
      node("csrf_token", "hidden", "csrf-1"),
      node("identifier", "text", ""),
      node("password", "password", "", "password"),
      node("method", "submit", "password", "password"),
      node("provider", "submit", "cp", "oidc"),
      node("passkey_login_trigger", "button", "", "passkey"),
    ],
  },
} as unknown as KratosFlow;

describe("passwordLoginBody", () => {
  it("posts the hidden fields, the password method and the credentials only", () => {
    expect(passwordLoginBody(FLOW, "bob@example.com", "s3cret-pw")).toEqual({
      csrf_token: "csrf-1",
      method: "password",
      identifier: "bob@example.com",
      password: "s3cret-pw",
    });
  });
});
