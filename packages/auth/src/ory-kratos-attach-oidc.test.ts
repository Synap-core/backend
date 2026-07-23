import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachOidcCredentialToIdentity } from "./ory-kratos.js";

/**
 * Unit coverage for the silent-federated-sign-in wire. This is the one piece
 * that can't be curl-tested against a live pod (it writes to Kratos), so we
 * mock the admin API and assert the exact request shape — especially that the
 * PUT preserves the password and merges (not replaces) oidc providers.
 */
function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const IDENTITY = {
  schema_id: "default",
  state: "active",
  traits: { email: "owner@example.com" },
  metadata_public: { createdVia: "federated-initial-owner-bootstrap" },
  credentials: {
    password: { config: { hashed_password: "$argon2id$v=19$hash" } },
    oidc: { config: { providers: [{ provider: "google", subject: "g-1" }] } },
    // 2FA — MUST survive the attach. A full-replace PUT that omits this deletes it.
    totp: {
      config: {
        totp_url: "otpauth://totp/Synap:owner@example.com?secret=JBSW",
      },
    },
    lookup_secret: { config: { recovery_codes: [{ code: "abc-123" }] } },
  },
};

describe("attachOidcCredentialToIdentity", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects missing input without hitting Kratos", async () => {
    const res = await attachOidcCredentialToIdentity({
      kratosIdentityId: "",
      provider: "cp",
      subject: "s",
    });
    expect(res).toEqual({ ok: false, reason: "missing-input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches credential configs, then PUTs merged identity preserving the password", async () => {
    fetchMock
      .mockResolvedValueOnce(fakeRes(200, IDENTITY)) // GET identity
      .mockResolvedValueOnce(fakeRes(200, {})); // PUT

    const res = await attachOidcCredentialToIdentity({
      kratosIdentityId: "id-1",
      provider: "cp",
      subject: "cp-42",
    });
    expect(res).toEqual({ ok: true });

    // GET must ask for EVERY credential config, or the full-replace PUT drops
    // whatever it didn't fetch (2FA included).
    const getUrl = String(fetchMock.mock.calls[0][0]);
    expect(getUrl).toContain("/admin/identities/id-1");
    expect(getUrl).toContain("include_credential=password");
    expect(getUrl).toContain("include_credential=oidc");
    expect(getUrl).toContain("include_credential=totp");
    expect(getUrl).toContain("include_credential=webauthn");
    expect(getUrl).toContain("include_credential=lookup_secret");

    const putUrl = String(fetchMock.mock.calls[1][0]);
    const putInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(putUrl).toContain("/admin/identities/id-1");
    expect(putInit.method).toBe("PUT");
    const body = JSON.parse(String(putInit.body));
    // Password preserved via its hash — never wiped.
    expect(body.credentials.password.config.hashed_password).toBe(
      "$argon2id$v=19$hash"
    );
    // Providers MERGED (existing google + new cp), not replaced.
    expect(body.credentials.oidc.config.providers).toEqual([
      { provider: "google", subject: "g-1" },
      { subject: "cp-42", provider: "cp" },
    ]);
    // 2FA / passwordless credentials round-trip UNTOUCHED — the regression this
    // fix closes (a full-replace PUT that omits them silently strips 2FA on
    // every backfill boot).
    expect(body.credentials.totp).toEqual(IDENTITY.credentials.totp);
    expect(body.credentials.lookup_secret).toEqual(
      IDENTITY.credentials.lookup_secret
    );
    // Identity fields round-tripped so Kratos doesn't clear them.
    expect(body.schema_id).toBe("default");
    expect(body.traits).toEqual({ email: "owner@example.com" });
    expect(body.metadata_public).toEqual({
      createdVia: "federated-initial-owner-bootstrap",
    });
  });

  it("is idempotent — no PUT when provider+subject already present", async () => {
    const already = {
      ...IDENTITY,
      credentials: {
        ...IDENTITY.credentials,
        oidc: { config: { providers: [{ provider: "cp", subject: "cp-42" }] } },
      },
    };
    fetchMock.mockResolvedValueOnce(fakeRes(200, already));
    const res = await attachOidcCredentialToIdentity({
      kratosIdentityId: "id-1",
      provider: "cp",
      subject: "cp-42",
    });
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only, no PUT
  });

  it("creates the oidc credential on an identity that has none (no password to keep)", async () => {
    const bare = {
      schema_id: "default",
      state: "active",
      traits: { email: "x@y.z" },
      credentials: {},
    };
    fetchMock
      .mockResolvedValueOnce(fakeRes(200, bare))
      .mockResolvedValueOnce(fakeRes(200, {}));
    const res = await attachOidcCredentialToIdentity({
      kratosIdentityId: "id-2",
      provider: "cp",
      subject: "cp-9",
    });
    expect(res).toEqual({ ok: true });
    const body = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(body.credentials.password).toBeUndefined();
    expect(body.credentials.oidc.config.providers).toEqual([
      { subject: "cp-9", provider: "cp" },
    ]);
  });

  it("surfaces a reason when the identity fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes(404, null));
    const res = await attachOidcCredentialToIdentity({
      kratosIdentityId: "id-x",
      provider: "cp",
      subject: "s",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("identity-fetch-failed");
  });

  it("surfaces a reason when the PUT fails (and never silently claims success)", async () => {
    fetchMock
      .mockResolvedValueOnce(fakeRes(200, IDENTITY))
      .mockResolvedValueOnce(fakeRes(400, null));
    const res = await attachOidcCredentialToIdentity({
      kratosIdentityId: "id-1",
      provider: "cp",
      subject: "cp-42",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("identity-update-failed:400");
  });
});
