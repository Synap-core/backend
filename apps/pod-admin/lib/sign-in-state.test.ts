import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KRATOS_ACCOUNT_LINK_IDS,
  POD_ACCESS_REQUIRED,
  SELF_REGISTRATION_DISABLED,
} from "@synap-core/types/kratos-messages";
import {
  collectErrorMessages,
  fetchSelfServiceFlow,
  type KratosFlow,
  type KratosMessage,
  type KratosUiNode,
} from "./kratos-flow";
import { classifySignInFlow, isStateMessage } from "./sign-in-state";

/*
 * Fixtures follow what Kratos v1.3.1 actually emits:
 *  - gate refusal: the web_hook interrupt lands in the REGISTRATION flow's
 *    global ui.messages; the oidc error path re-adds trait nodes with values.
 *  - account linking: selfservice/strategy/oidc/strategy.go
 *    populateAccountLinkingUI — ui.messages = [1010016 info, context
 *    duplicateIdentifier], identifier node hidden with that value, submit node
 *    relabelled 1010017 "Sign in and link".
 */

function flow(
  messages: KratosMessage[],
  nodes: KratosUiNode[] = []
): KratosFlow {
  return {
    id: "flow-1",
    type: "browser",
    ui: { action: "https://pod.example/x", method: "POST", messages, nodes },
  };
}

const gateRefusal: KratosMessage = {
  id: POD_ACCESS_REQUIRED.id,
  type: "error",
  text: POD_ACCESS_REQUIRED.text,
  context: { reason: "pod_access_required" },
};

const traitsEmail: KratosUiNode = {
  type: "input",
  group: "oidc",
  attributes: { name: "traits.email", type: "email", value: "ada@example.com" },
};

const hiddenIdentifier: KratosUiNode = {
  type: "input",
  group: "default",
  attributes: { name: "identifier", type: "hidden", value: "ada@example.com" },
};

const linkSubmit: KratosUiNode = {
  type: "input",
  group: "password",
  attributes: { name: "method", type: "submit", value: "password" },
  meta: { label: { id: 1010017, text: "Sign in and link" } },
};

const linkBanner: KratosMessage = {
  id: 1010016,
  type: "info",
  text: 'You tried to sign in with "ada@example.com", but that email is already used by another account.',
  context: { duplicateIdentifier: "ada@example.com", provider: "Synap Cloud" },
};

const invalidCredentials: KratosMessage = {
  id: 4000006,
  type: "error",
  text: "The provided credentials are invalid, check for spelling mistakes in your password or username, email address, or phone number.",
};

describe("shared Kratos ids (verified against ory/kratos v1.3.1 text/id.go)", () => {
  it("pins the values clients and the gate agree on", () => {
    expect(POD_ACCESS_REQUIRED.id).toBe(4000901);
    expect(SELF_REGISTRATION_DISABLED.id).toBe(4000902);
    expect(KRATOS_ACCOUNT_LINK_IDS).toEqual({
      loginLink: 1010016,
      loginAndLink: 1010017,
      loginWithAndLink: 1010018,
      duplicateCredentialsOnOidcLink: 4000027,
    });
  });
});

describe("classifySignInFlow", () => {
  it("gate 4000901 on the registration flow → access_required with the Cloud email", () => {
    expect(
      classifySignInFlow(flow([gateRefusal], [traitsEmail]), "registration")
    ).toEqual({ kind: "access_required", email: "ada@example.com" });
  });

  it("matches the refusal by context.reason alone (message without an id)", () => {
    const { id: _id, ...noId } = gateRefusal;
    expect(classifySignInFlow(flow([noId]), "registration")).toEqual({
      kind: "access_required",
      email: null,
    });
  });

  it("account linking (1010016 banner) → account_link with duplicateIdentifier", () => {
    expect(
      classifySignInFlow(
        flow([linkBanner], [hiddenIdentifier, linkSubmit]),
        "login"
      )
    ).toEqual({ kind: "account_link", email: "ada@example.com" });
  });

  it("still linking after a wrong password replaced the banner (1010017 label)", () => {
    expect(
      classifySignInFlow(
        flow([invalidCredentials], [hiddenIdentifier, linkSubmit]),
        "login"
      )
    ).toEqual({ kind: "account_link", email: "ada@example.com" });
  });

  it("4000027 duplicate-on-oidc fallback → account_link", () => {
    expect(
      classifySignInFlow(
        flow(
          [
            {
              id: 4000027,
              type: "error",
              text: "An account with the same identifier exists already.",
            },
          ],
          [hiddenIdentifier]
        ),
        "login"
      )
    ).toEqual({ kind: "account_link", email: "ada@example.com" });
  });

  it("gate 4000902 → self_registration_disabled", () => {
    expect(
      classifySignInFlow(
        flow([
          {
            id: SELF_REGISTRATION_DISABLED.id,
            type: "error",
            text: SELF_REGISTRATION_DISABLED.text,
            context: { reason: "self_registration_disabled" },
          },
        ]),
        "registration"
      )
    ).toEqual({ kind: "self_registration_disabled" });
  });

  it("a bare registration flow (sign-up opened directly) → self_registration_disabled", () => {
    expect(classifySignInFlow(flow([]), "registration")).toEqual({
      kind: "self_registration_disabled",
    });
  });

  // Discriminating rows: each rules out a looser rule.
  it("a wrong password on a NORMAL login stays `none` (not linking)", () => {
    expect(
      classifySignInFlow(
        flow([invalidCredentials], [hiddenIdentifier]),
        "login"
      )
    ).toEqual({ kind: "none" });
  });

  it("any other registration error stays `none` (keeps the banner)", () => {
    expect(
      classifySignInFlow(
        flow([{ id: 5000001, type: "error", text: "system error" }]),
        "registration"
      )
    ).toEqual({ kind: "none" });
  });

  it("a plain login flow is `none`", () => {
    expect(classifySignInFlow(flow([], [hiddenIdentifier]), "login")).toEqual({
      kind: "none",
    });
  });
});

describe("banner keeps other errors, drops state messages", () => {
  it("collectErrorMessages(flow, isStateMessage)", () => {
    const f = flow([gateRefusal, invalidCredentials]);
    expect(collectErrorMessages(f, isStateMessage)).toEqual([
      invalidCredentials.text,
    ]);
    expect(collectErrorMessages(f)).toHaveLength(2);
  });
});

describe("fetchSelfServiceFlow", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    process.env.POD_PUBLIC_URL = "https://pod.example.com";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POD_PUBLIC_URL;
  });

  function stubFetch(responses: Record<string, Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const key = url.includes("/registration/") ? "registration" : "login";
        return responses[key] ?? new Response("{}", { status: 500 });
      })
    );
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("a registration flow id (login 404) resolves through the registration endpoint", async () => {
    stubFetch({
      login: json({ error: { code: 404, message: "not found" } }, 404),
      registration: json(flow([gateRefusal])),
    });
    const r = await fetchSelfServiceFlow("flow-1");
    expect(r.kind).toBe("registration");
    expect(calls).toHaveLength(2);
  });

  it("a login flow id never touches the registration endpoint", async () => {
    stubFetch({ login: json(flow([])) });
    const r = await fetchSelfServiceFlow("flow-1");
    expect(r.kind).toBe("login");
    expect(calls).toHaveLength(1);
  });

  it("a non-404 failure is reported, not retried as registration", async () => {
    stubFetch({
      login: json({ error: { message: "flow expired" } }, 410),
      registration: json(flow([])),
    });
    await expect(fetchSelfServiceFlow("flow-1")).rejects.toThrow(
      "flow expired"
    );
    expect(calls).toHaveLength(1);
  });
});
