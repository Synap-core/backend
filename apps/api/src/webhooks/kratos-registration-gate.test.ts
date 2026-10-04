import { beforeEach, describe, expect, it, vi } from "vitest";
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
  podOwner?: unknown;
  emailVerified?: unknown;
  iss?: string;
  noCloud?: boolean;
}) {
  return {
    method: opts.method ?? "oidc",
    identity: {
      id: opts.id ?? "00000000-0000-0000-0000-000000000000",
      traits: { email: "Owner@Example.com", name: "Owner" },
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

function makeDeps(
  overrides: Partial<RegistrationGateDeps> = {}
): RegistrationGateDeps {
  return {
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
    ...overrides,
  };
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
