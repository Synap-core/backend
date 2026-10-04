/**
 * A recovery `?flow=` renders the RECOVERY UI, never the login form.
 *
 * Kratos sends recovery flows to /recovery (generate_kratos_config); a pod on
 * an older kratos.yml still sends them to /login, which forwards them here
 * (`pageForFlow`, covered in lib/kratos-flow.recovery.test.ts). This pins what
 * /recovery draws for the two states of a Kratos v1.3.1 code recovery flow,
 * server-rendered through the real components.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { KratosFlow } from "../../lib/kratos-flow";
import { initialFieldValues } from "../_lib/kratos-fields";
import { RecoveryFlowPanel } from "./RecoveryView";

const csrf = {
  type: "input",
  group: "default",
  attributes: { name: "csrf_token", type: "hidden", value: "csrf-1" },
};

/** Kratos v1.3.1 recovery flow, state choose_method (code strategy). */
const chooseMethod: KratosFlow = {
  id: "rec-1",
  type: "browser",
  state: "choose_method",
  ui: {
    action: "https://pod.example.com/self-service/recovery?flow=rec-1",
    method: "POST",
    nodes: [
      csrf,
      {
        type: "input",
        group: "code",
        attributes: { name: "email", type: "email", required: true },
        meta: { label: { text: "Email" } },
      },
      {
        type: "input",
        group: "code",
        attributes: { name: "method", type: "submit", value: "code" },
        meta: { label: { text: "Submit" } },
      },
    ],
  },
};

/** state sent_email: code input, the method submit, and a RESEND submit named `email`. */
const sentEmail: KratosFlow = {
  ...chooseMethod,
  state: "sent_email",
  ui: {
    ...chooseMethod.ui,
    nodes: [
      csrf,
      {
        type: "input",
        group: "code",
        attributes: { name: "code", type: "text", required: true },
        meta: { label: { text: "Recovery code" } },
      },
      {
        type: "input",
        group: "code",
        attributes: { name: "method", type: "submit", value: "code" },
        meta: { label: { text: "Submit" } },
      },
      {
        type: "input",
        group: "code",
        attributes: { name: "email", type: "submit", value: "owner@example.com" },
        meta: { label: { text: "Resend code" } },
      },
    ],
  },
};

function render(flow: KratosFlow) {
  return renderToString(
    <RecoveryFlowPanel
      flow={flow}
      values={initialFieldValues(flow, ["code", "link"])}
      setValues={() => undefined}
      submitting={false}
      error={null}
      onSubmit={() => undefined}
    />
  );
}

describe("/recovery?flow= renders the recovery flow, not login", () => {
  it("choose_method: asks for the email and sends a code", () => {
    const html = render(chooseMethod);
    expect(html).toContain("Email me a code");
    expect(html).toContain('name="email"');
    expect(html).toContain("Send code");
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('name="identifier"');
  });

  it("sent_email: asks for the code, offers resend, never a sign-in form", () => {
    const html = render(sentEmail);
    expect(html).toContain("Enter your code");
    expect(html).toContain('name="code"');
    expect(html).toContain("Recover account");
    expect(html).toContain("Resend code");
    expect(html).not.toContain("Sign in");
  });
});

describe("the code submit never carries the resend button's value", () => {
  it("initial values hold hidden + typed fields only", () => {
    // Kratos treats any non-empty `email` on a sent_email flow as a RESEND
    // (strategy_recovery.go) — folding the resend button's value into the
    // primary submit would resend instead of verifying the code.
    expect(initialFieldValues(sentEmail, ["code", "link"])).toEqual({
      csrf_token: "csrf-1",
      code: "",
    });
  });
});
