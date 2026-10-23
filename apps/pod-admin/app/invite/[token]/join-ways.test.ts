import { describe, expect, it, vi } from "vitest";
import type { KratosFlow, KratosUiNode } from "../../../lib/kratos-flow";
import { PasskeyCancelled } from "../../../lib/passkey";
import {
  JOIN_FAILED,
  joinWithPasskey,
  joinWithSynapCloud,
  type JoinDeps,
} from "./join-ways";

const input = (name: string, value: string): KratosUiNode => ({
  type: "input",
  group: "default",
  attributes: { name, type: "hidden", value },
});

/** A Kratos v1.3.1 registration flow; step one holds no passkey data. */
function flow(id: string, nodes: KratosUiNode[], messages: string[] = []) {
  return {
    id,
    ui: {
      action: `https://pod.example.com/self-service/registration?flow=${id}`,
      method: "POST",
      nodes: [input("csrf_token", `csrf-${id}`), ...nodes],
      messages: messages.map((text) => ({ type: "error", text })),
    },
  } satisfies KratosFlow;
}
const stepOne = flow("f1", []);
const stepTwo = flow("f1b", [input("passkey_create_data", '{"x":1}')]);

function deps(over: Partial<JoinDeps> = {}): JoinDeps {
  return {
    createFlow: vi.fn(async () => ({ flow: stepOne })),
    submit: vi.fn(async (_f, body) =>
      body.method === "profile"
        ? { kind: "flow" as const, flow: stepTwo }
        : body.method === "oidc"
          ? { kind: "redirect" as const, to: "https://api.synap.live/oauth" }
          : {
              kind: "session" as const,
              session: { id: "s", active: true, identity: { id: "i" } },
            }
    ),
    createPasskey: vi.fn(async () => '{"id":"cred"}'),
    ...over,
  };
}

const PASSKEY = {
  token: "tok-1",
  email: "ada@example.com",
  name: "Ada",
  returnTo: "https://admin.lab.pod.synap.live/invite/tok-1",
};

describe("joinWithPasskey", () => {
  it("profile step, then the passkey, with the invite in transient_payload", async () => {
    const d = deps();
    expect(await joinWithPasskey(PASSKEY, d)).toEqual({
      kind: "joined",
      signedIn: true,
    });
    expect(d.createFlow).toHaveBeenCalledWith(PASSKEY.returnTo);
    const [profileCall, passkeyCall] = vi.mocked(d.submit).mock.calls;
    expect(profileCall![1]).toEqual({
      method: "profile",
      csrf_token: "csrf-f1",
      traits: { email: "ada@example.com", name: "Ada" },
      transient_payload: { invite_token: "tok-1" },
    });
    expect(d.createPasskey).toHaveBeenCalledWith('{"x":1}', {
      name: "ada@example.com",
      displayName: "Ada",
    });
    expect(passkeyCall![0]).toBe(stepTwo);
    expect(passkeyCall![1]).toEqual({
      method: "passkey",
      csrf_token: "csrf-f1b",
      traits: { email: "ada@example.com", name: "Ada" },
      passkey_register: '{"id":"cred"}',
      transient_payload: { invite_token: "tok-1" },
    });
  });

  it("skips the profile step when the flow already holds the passkey data", async () => {
    const d = deps({ createFlow: vi.fn(async () => ({ flow: stepTwo })) });
    await joinWithPasskey(PASSKEY, d);
    expect(vi.mocked(d.submit).mock.calls.map((c) => c[1].method)).toEqual([
      "passkey",
    ]);
  });

  it("says the gate's refusal in its own words", async () => {
    const refused = flow(
      "f1c",
      [],
      [
        "This invitation was sent to a different email. Use the invited email to join.",
      ]
    );
    const d = deps({
      submit: vi.fn(async (_f, body) =>
        body.method === "profile"
          ? { kind: "flow" as const, flow: stepTwo }
          : { kind: "flow" as const, flow: refused }
      ),
    });
    expect(await joinWithPasskey(PASSKEY, d)).toEqual({
      kind: "refused",
      message:
        "This invitation was sent to a different email. Use the invited email to join.",
    });
  });

  it("a dismissed passkey prompt is cancelled, and nothing is submitted", async () => {
    const d = deps({
      createPasskey: vi.fn(async () => {
        throw new PasskeyCancelled();
      }),
    });
    expect(await joinWithPasskey(PASSKEY, d)).toEqual({ kind: "cancelled" });
    expect(vi.mocked(d.submit).mock.calls.map((c) => c[1].method)).toEqual([
      "profile",
    ]);
  });

  it("a signed-in browser hands back to the page", async () => {
    const d = deps({
      createFlow: vi.fn(async () => ({ existingSession: true as const })),
    });
    expect(await joinWithPasskey(PASSKEY, d)).toEqual({ kind: "signed-in" });
  });

  it("no passkey data after the profile step is a refusal, never a silent no-op", async () => {
    const d = deps({
      submit: vi.fn(async () => ({ kind: "flow" as const, flow: stepOne })),
    });
    const r = await joinWithPasskey(PASSKEY, d);
    expect(r.kind).toBe("refused");
    expect(d.createPasskey).not.toHaveBeenCalled();
  });
});

describe("joinWithSynapCloud", () => {
  it("submits the cp provider with the invite and follows the redirect", async () => {
    const d = deps();
    expect(
      await joinWithSynapCloud(
        { token: "tok-1", returnTo: PASSKEY.returnTo },
        d
      )
    ).toEqual({ kind: "redirect", to: "https://api.synap.live/oauth" });
    expect(vi.mocked(d.submit).mock.calls[0]![1]).toEqual({
      method: "oidc",
      provider: "cp",
      csrf_token: "csrf-f1",
      transient_payload: { invite_token: "tok-1" },
    });
  });

  it("a failed submit is a refusal with a way out", async () => {
    const d = deps({
      submit: vi.fn(async () => ({
        kind: "error" as const,
        error: { message: "" },
      })),
    });
    expect(
      await joinWithSynapCloud({ token: "t", returnTo: PASSKEY.returnTo }, d)
    ).toEqual({ kind: "refused", message: JOIN_FAILED });
  });
});
