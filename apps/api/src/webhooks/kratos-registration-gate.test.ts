import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudTrustMode } from "@synap-core/types/account-recovery";
import {
  createRegistrationGateRouter,
  POD_ACCESS_REQUIRED,
  type RegistrationGateDeps,
} from "./kratos-registration-gate.js";

const SECRET = "test-webhook-secret";
const ISSUER = "https://api.synap.live";
const IDENTITY_ID = "11111111-2222-3333-4444-555555555555";

/**
 * The body is the exact shape our jsonnet emits: `{ method, identity }`, where
 * `identity` is Kratos' `Identity.MarshalJSON` (no credentials/metadata_admin)
 * and `metadata_public.synap_cp` is written by `kratos/oidc.cp.jsonnet`.
 */
function body(opts: {
  method?: string;
  id?: string;
  email?: string;
  podOwner?: unknown;
  emailVerified?: unknown;
  iss?: string;
  noCloud?: boolean;
  /** `transient_payload` as the oidc hook body forwards it (null = none). */
  inviteToken?: string;
}) {
  return {
    method: opts.method ?? "oidc",
    transient_payload:
      opts.inviteToken === undefined
        ? null
        : { invite_token: opts.inviteToken },
    identity: {
      id: opts.id ?? "00000000-0000-0000-0000-000000000000",
      traits: { email: opts.email ?? "Owner@Example.com", name: "Owner" },
      metadata_public: opts.noCloud
        ? null
        : {
            synap_cp: {
              iss: opts.iss ?? ISSUER,
              sub: "cp-user-1",
              email_verified: opts.emailVerified ?? true,
              pod_owner: opts.podOwner ?? true,
            },
          },
    },
  };
}

const INVITE_TOKEN = "invite-token-1";
const INVITED = "invitee@example.com";
const inFuture = () => new Date(Date.now() + 60 * 60 * 1000);

function makeDeps(
  overrides: Partial<RegistrationGateDeps> = {}
): RegistrationGateDeps {
  return {
    readCloudTrust: vi.fn(async (): Promise<CloudTrustMode> => "sign_in"),
    readFederationIssuer: vi.fn(async () => ISSUER),
    normalizeIssuerUrl: (url: string) => url.replace(/\/+$/, ""),
    hasDifferentHumanOwner: vi.fn(async () => false),
    kratosEmailExists: vi.fn(async () => false),
    podUserExists: vi.fn(async () => false),
    claimOwner: vi.fn(async () => ({
      status: "claimed" as const,
      userId: IDENTITY_ID,
      issuerApproved: true,
    })),
    deleteKratosIdentity: vi.fn(async () => true),
    findInvite: vi.fn(async (token: string) =>
      token === INVITE_TOKEN ? { email: INVITED, expiresAt: inFuture() } : null
    ),
    acceptInvite: vi.fn(async () => "accepted" as const),
    ...overrides,
  };
}

/** An invitee's Cloud sign-up from the invite page (not a pod owner). */
function inviteeBody(opts: Parameters<typeof body>[0] = {}) {
  return body({
    podOwner: false,
    email: "Invitee@Example.com",
    inviteToken: INVITE_TOKEN,
    ...opts,
  });
}

async function expectRefusal(res: Response, id: number, reason: string) {
  expect(res.status).toBe(403);
  const msg = ((await res.json()) as any).messages[0].messages[0];
  expect(msg.id).toBe(id);
  expect(msg.context).toEqual({ reason });
}

async function post(
  deps: RegistrationGateDeps,
  path: "/gate" | "/complete",
  payload: unknown,
  secret: string | null = SECRET
) {
  const app = createRegistrationGateRouter(deps);
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Webhook-Secret": secret } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function expectAccessDenied(res: Response) {
  expect(res.status).toBe(403);
  const json = (await res.json()) as any;
  const msg = json.messages[0].messages[0];
  expect(msg).toEqual({
    id: 4000901,
    text: "You don't have access to this pod yet.",
    type: "error",
    context: { reason: "pod_access_required" },
  });
  expect(json.messages[0].instance_ptr).toBe("#/");
}

describe("Kratos registration gate (pre-persist, can_interrupt)", () => {
  beforeEach(() => {
    process.env.KRATOS_WEBHOOK_SECRET = SECRET;
  });

  it("exports the contract constant clients match on", () => {
    expect(POD_ACCESS_REQUIRED.id).toBe(4000901);
    expect(POD_ACCESS_REQUIRED.context.reason).toBe("pod_access_required");
  });

  it("allows a verified CP pod owner when the pod has no human owner", async () => {
    const deps = makeDeps();
    const res = await post(deps, "/gate", body({}));
    expect(res.status).toBe(204);
    expect(deps.hasDifferentHumanOwner).toHaveBeenCalledWith(
      ISSUER,
      "cp-user-1"
    );
  });

  it("denies a Cloud user with no pod access (no owner claim, unknown email)", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(deps, "/gate", body({ podOwner: false }))
    );
    expect(deps.kratosEmailExists).toHaveBeenCalledWith("owner@example.com");
  });

  it("denies the owner claim when a DIFFERENT human owner already exists", async () => {
    const deps = makeDeps({ hasDifferentHumanOwner: vi.fn(async () => true) });
    await expectAccessDenied(await post(deps, "/gate", body({})));
  });

  it("denies the owner claim when the email is not verified", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(deps, "/gate", body({ emailVerified: false }))
    );
    // A string "true" is not proof either.
    await expectAccessDenied(
      await post(deps, "/gate", body({ emailVerified: "true" }))
    );
  });

  it("denies a claim from an issuer other than the pod's configured CP", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(deps, "/gate", body({ iss: "https://evil.example" }))
    );
  });

  it("denies password self-registration outright — with its OWN message", async () => {
    const deps = makeDeps({ kratosEmailExists: vi.fn(async () => true) });
    const res = await post(
      deps,
      "/gate",
      body({ method: "password", noCloud: true })
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    // Distinct from 4000901: clients render "created by invitation or with
    // Synap Cloud", not "ask the owner for access".
    expect(json.messages[0].messages[0]).toEqual({
      id: 4000902,
      text: "New accounts on this pod are created by invitation or with Synap Cloud.",
      type: "error",
      context: { reason: "self_registration_disabled" },
    });
    expect(json.messages[0].instance_ptr).toBe("#/");
  });

  it("lets an EXISTING account through so Kratos can run account linking", async () => {
    const deps = makeDeps({ kratosEmailExists: vi.fn(async () => true) });
    const res = await post(deps, "/gate", body({ podOwner: false }));
    expect(res.status).toBe(204);
  });

  it("answers 503 (not a denial) when a read fails", async () => {
    const deps = makeDeps({
      kratosEmailExists: vi.fn(async () => {
        throw new Error("kratos down");
      }),
    });
    const res = await post(deps, "/gate", body({ podOwner: false }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).messages).toBeUndefined();
  });

  it("rejects a bad or missing webhook secret", async () => {
    const deps = makeDeps();
    expect((await post(deps, "/gate", body({}), "wrong-secret")).status).toBe(
      401
    );
    expect((await post(deps, "/gate", body({}), null)).status).toBe(401);
    expect(deps.readFederationIssuer).not.toHaveBeenCalled();
  });

  it("refuses to run when KRATOS_WEBHOOK_SECRET is unset", async () => {
    delete process.env.KRATOS_WEBHOOK_SECRET;
    const res = await post(makeDeps(), "/gate", body({}));
    expect(res.status).toBe(500);
  });
});

describe("Kratos registration complete (post-persist owner claim)", () => {
  beforeEach(() => {
    process.env.KRATOS_WEBHOOK_SECRET = SECRET;
  });

  it("seeds the owner with the CP issuer + subject for the persisted identity", async () => {
    const deps = makeDeps();
    const res = await post(deps, "/complete", body({ id: IDENTITY_ID }));
    expect(res.status).toBe(200);
    expect(deps.claimOwner).toHaveBeenCalledWith({
      issuerUrl: ISSUER,
      issuerSubject: "cp-user-1",
      kratosIdentityId: IDENTITY_ID,
      email: "owner@example.com",
      name: "Owner",
    });
    expect(deps.deleteKratosIdentity).not.toHaveBeenCalled();
  });

  it("removes the identity when the owner claim loses a race", async () => {
    const deps = makeDeps({
      claimOwner: vi.fn(async () => ({ status: "owner_exists" as const })),
    });
    await expectAccessDenied(
      await post(deps, "/complete", body({ id: IDENTITY_ID }))
    );
    expect(deps.deleteKratosIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it("removes a persisted non-owner identity that has no pod user", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(deps, "/complete", body({ id: IDENTITY_ID, podOwner: false }))
    );
    expect(deps.claimOwner).not.toHaveBeenCalled();
    expect(deps.deleteKratosIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it("never claims ownership for an unverified email", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(
        deps,
        "/complete",
        body({ id: IDENTITY_ID, emailVerified: false })
      )
    );
    expect(deps.claimOwner).not.toHaveBeenCalled();
  });

  it("rejects a bad webhook secret before touching anything", async () => {
    const deps = makeDeps();
    const res = await post(deps, "/complete", body({ id: IDENTITY_ID }), "x");
    expect(res.status).toBe(401);
    expect(deps.claimOwner).not.toHaveBeenCalled();
    expect(deps.deleteKratosIdentity).not.toHaveBeenCalled();
  });
});

describe("Invite-bound Synap Cloud sign-up (join plan phase 4, B2 Q3 (a))", () => {
  beforeEach(() => {
    process.env.KRATOS_WEBHOOK_SECRET = SECRET;
  });

  it("lets the invited email through the gate", async () => {
    const deps = makeDeps();
    const res = await post(deps, "/gate", inviteeBody());
    expect(res.status).toBe(204);
    expect(deps.findInvite).toHaveBeenCalledWith(INVITE_TOKEN);
  });

  it("accepts the invite for the persisted identity at /complete", async () => {
    const deps = makeDeps();
    const res = await post(deps, "/complete", inviteeBody({ id: IDENTITY_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "invite" });
    expect(deps.acceptInvite).toHaveBeenCalledWith({
      token: INVITE_TOKEN,
      kratosIdentityId: IDENTITY_ID,
      email: INVITED,
      name: "Owner",
    });
    expect(deps.claimOwner).not.toHaveBeenCalled();
    expect(deps.deleteKratosIdentity).not.toHaveBeenCalled();
  });

  it("refuses ANOTHER email with its own message, and never accepts", async () => {
    const deps = makeDeps();
    await expectRefusal(
      await post(deps, "/gate", inviteeBody({ email: "someone@else.com" })),
      4000905,
      "invite_email_mismatch"
    );
    await expectAccessDenied(
      await post(
        deps,
        "/complete",
        inviteeBody({ id: IDENTITY_ID, email: "someone@else.com" })
      )
    );
    expect(deps.acceptInvite).not.toHaveBeenCalled();
    expect(deps.deleteKratosIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it("refuses the invited email when Synap Cloud has not verified it", async () => {
    const deps = makeDeps();
    await expectRefusal(
      await post(deps, "/gate", inviteeBody({ emailVerified: false })),
      4000905,
      "invite_email_mismatch"
    );
    await expectAccessDenied(
      await post(
        deps,
        "/complete",
        inviteeBody({ id: IDENTITY_ID, emailVerified: false })
      )
    );
    expect(deps.acceptInvite).not.toHaveBeenCalled();
  });

  it("refuses an expired invite, and never accepts it", async () => {
    const deps = makeDeps({
      findInvite: vi.fn(async () => ({
        email: INVITED,
        expiresAt: new Date(Date.now() - 1000),
      })),
    });
    await expectAccessDenied(await post(deps, "/gate", inviteeBody()));
    await expectAccessDenied(
      await post(deps, "/complete", inviteeBody({ id: IDENTITY_ID }))
    );
    expect(deps.acceptInvite).not.toHaveBeenCalled();
  });

  it("refuses an invite claimed through another provider's issuer", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(deps, "/gate", inviteeBody({ iss: "https://evil.example" }))
    );
  });

  it("removes the identity when the invite is gone by /complete", async () => {
    const deps = makeDeps({ acceptInvite: vi.fn(async () => "gone" as const) });
    await expectAccessDenied(
      await post(deps, "/complete", inviteeBody({ id: IDENTITY_ID }))
    );
    expect(deps.deleteKratosIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it("answers 503 (not a denial) when the invite read fails", async () => {
    const deps = makeDeps({
      findInvite: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const res = await post(deps, "/gate", inviteeBody());
    expect(res.status).toBe(503);
  });

  it("a password sign-up carrying an invite token is still refused", async () => {
    const deps = makeDeps();
    await expectRefusal(
      await post(
        deps,
        "/gate",
        inviteeBody({ method: "password", noCloud: true })
      ),
      4000902,
      "self_registration_disabled"
    );
    expect(deps.findInvite).not.toHaveBeenCalled();
  });

  it("the owner-only Cloud sign-up is unchanged (no invite token, no invite read)", async () => {
    const deps = makeDeps();
    expect((await post(deps, "/gate", body({}))).status).toBe(204);
    expect(
      (await post(deps, "/complete", body({ id: IDENTITY_ID }))).status
    ).toBe(200);
    expect(deps.claimOwner).toHaveBeenCalled();
    expect(deps.findInvite).not.toHaveBeenCalled();
    expect(deps.acceptInvite).not.toHaveBeenCalled();
  });
});

describe('"Allow sign-in with Synap Cloud" off (ADDENDUM 2026-10-23)', () => {
  beforeEach(() => {
    process.env.KRATOS_WEBHOOK_SECRET = SECRET;
  });
  const off = () =>
    makeDeps({
      readCloudTrust: vi.fn(async (): Promise<CloudTrustMode> => "off"),
    });

  it("refuses the owner's Cloud claim and the invite-bound join at the gate", async () => {
    const deps = off();
    await expectRefusal(
      await post(deps, "/gate", body({})),
      4000904,
      "cloud_sign_in_disabled"
    );
    await expectRefusal(
      await post(deps, "/gate", inviteeBody()),
      4000904,
      "cloud_sign_in_disabled"
    );
    expect(deps.findInvite).not.toHaveBeenCalled();
  });

  it("refuses an existing account's first Cloud sign-in too", async () => {
    const deps = off();
    deps.kratosEmailExists = vi.fn(async () => true);
    await expectRefusal(
      await post(deps, "/gate", body({ podOwner: false })),
      4000904,
      "cloud_sign_in_disabled"
    );
  });

  it("removes an identity persisted after the switch moved, and seeds nothing", async () => {
    const deps = off();
    await expectRefusal(
      await post(deps, "/complete", inviteeBody({ id: IDENTITY_ID })),
      4000904,
      "cloud_sign_in_disabled"
    );
    expect(deps.acceptInvite).not.toHaveBeenCalled();
    expect(deps.claimOwner).not.toHaveBeenCalled();
    expect(deps.deleteKratosIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it("leaves the password refusal as it was", async () => {
    const deps = off();
    await expectRefusal(
      await post(deps, "/gate", body({ method: "password", noCloud: true })),
      4000902,
      "self_registration_disabled"
    );
  });

  it("answers 503 when the switch cannot be read", async () => {
    const deps = makeDeps({
      readCloudTrust: vi.fn(async (): Promise<CloudTrustMode> => {
        throw new Error("db down");
      }),
    });
    expect((await post(deps, "/gate", inviteeBody())).status).toBe(503);
  });
});

describe("Passkey registration (gated since 2026-10-23: it had no hook)", () => {
  beforeEach(() => {
    process.env.KRATOS_WEBHOOK_SECRET = SECRET;
  });

  /** A passkey sign-up from the invite page: traits typed, no Cloud claims. */
  const passkeyBody = (opts: Parameters<typeof body>[0] = {}) =>
    inviteeBody({ method: "passkey", noCloud: true, ...opts });

  it("refuses a passkey self-registration with no invite", async () => {
    // Even for an email an account already holds (no account-linking door).
    const deps = makeDeps({ kratosEmailExists: vi.fn(async () => true) });
    await expectRefusal(
      await post(deps, "/gate", body({ method: "passkey", noCloud: true })),
      4000902,
      "self_registration_disabled"
    );
    expect(deps.findInvite).not.toHaveBeenCalled();
  });

  it("a passkey sign-up carrying forged Cloud owner claims is still refused", async () => {
    const deps = makeDeps();
    const res = await post(deps, "/gate", body({ method: "passkey" }));
    expect(res.status).toBe(403);
    expect(deps.hasDifferentHumanOwner).not.toHaveBeenCalled();
  });

  it("refuses a passkey registration with an unknown or expired token", async () => {
    const deps = makeDeps();
    await expectRefusal(
      await post(deps, "/gate", passkeyBody({ inviteToken: "nope" })),
      4000902,
      "self_registration_disabled"
    );
  });

  it("lets the invited email make a passkey account, accepted at /complete", async () => {
    const deps = makeDeps();
    expect((await post(deps, "/gate", passkeyBody())).status).toBe(204);
    const res = await post(deps, "/complete", passkeyBody({ id: IDENTITY_ID }));
    expect(res.status).toBe(200);
    expect(deps.acceptInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        token: INVITE_TOKEN,
        kratosIdentityId: IDENTITY_ID,
        email: INVITED,
      })
    );
  });

  it("refuses a passkey account for another email than the invite's", async () => {
    const deps = makeDeps();
    await expectRefusal(
      await post(deps, "/gate", passkeyBody({ email: "someone@else.com" })),
      4000905,
      "invite_email_mismatch"
    );
  });

  it("removes a passkey identity persisted without an invite", async () => {
    const deps = makeDeps();
    await expectAccessDenied(
      await post(
        deps,
        "/complete",
        body({ method: "passkey", noCloud: true, id: IDENTITY_ID })
      )
    );
    expect(deps.acceptInvite).not.toHaveBeenCalled();
    expect(deps.deleteKratosIdentity).toHaveBeenCalledWith(IDENTITY_ID);
  });

  it("is not affected by the Synap Cloud switch", async () => {
    const deps = makeDeps({
      readCloudTrust: vi.fn(async (): Promise<CloudTrustMode> => "off"),
    });
    expect((await post(deps, "/gate", passkeyBody())).status).toBe(204);
  });
});
