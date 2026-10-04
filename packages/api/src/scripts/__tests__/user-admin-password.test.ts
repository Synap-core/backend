import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  PasswordStepError,
  parseSecretFromStdin,
  readStdin,
  setPasswordAndVerify,
  type KratosAdminLike,
} from "../user-admin-password.js";

const URL_ = "http://kratos:4433";

/** Fake Kratos: stores the password set via admin PUT; login succeeds only for it. */
function fakeKratos(opts: { credentials?: boolean; refuse?: number } = {}) {
  let stored: string | null = null;
  const puts: Record<string, unknown>[] = [];
  const admin: KratosAdminLike = {
    getIdentity: async () => ({
      data: {
        id: "id1",
        schema_id: "default",
        state: "active",
        traits: { email: "Owner@Example.com" },
        metadata_public: { role: "owner" },
      },
    }),
    updateIdentity: async ({ updateIdentityBody }) => {
      if (opts.refuse) throw { response: { status: opts.refuse } };
      puts.push(updateIdentityBody);
      stored = (
        updateIdentityBody.credentials as {
          password: { config: { password: string } };
        }
      ).password.config.password;
    },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/self-service/login/api"))
      return new Response(JSON.stringify({ id: "flow1" }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    const ok =
      url.includes("flow=flow1") &&
      body.method === "password" &&
      body.identifier === "Owner@Example.com" &&
      body.password === stored;
    return new Response("{}", { status: ok ? 200 : 400 });
  }) as unknown as typeof fetch;
  return {
    admin,
    fetchImpl,
    puts,
    setStored: (v: string | null) => (stored = v),
  };
}

const run = (
  k: ReturnType<typeof fakeKratos>,
  password = "S3cret pass'word\"$x"
) =>
  setPasswordAndVerify({
    admin: k.admin,
    identityId: "id1",
    email: "owner@example.com",
    password,
    publicUrl: URL_,
    fetchImpl: k.fetchImpl,
  });

describe("stdin parsing", () => {
  it("strips exactly one trailing newline and keeps quotes/spaces", () => {
    expect(parseSecretFromStdin('pa\'ss "w"$x\n')).toBe('pa\'ss "w"$x');
    expect(parseSecretFromStdin("abc\r\n")).toBe("abc");
    expect(parseSecretFromStdin("abc\n\n")).toBe("abc\n");
  });
  it("rejects empty input", () => {
    expect(() => parseSecretFromStdin("")).toThrow(/empty/);
    expect(() => parseSecretFromStdin("\n")).toThrow(/empty/);
  });
  it("reads a whole stream", async () => {
    expect(await readStdin(Readable.from(["a'b", " c\n"]))).toBe("a'b c\n");
  });
});

describe("setPasswordAndVerify", () => {
  it("sets a password on an identity with NO password credential, then proves login", async () => {
    const k = fakeKratos(); // stored === null: no password credential yet
    await expect(run(k)).resolves.toBeUndefined();
    expect(k.puts).toHaveLength(1);
    // metadata survives the PUT (a PUT replaces the identity)
    expect(k.puts[0]!.metadata_public).toEqual({ role: "owner" });
  });

  it("fails with verification-login-failed when the login does not accept the password", async () => {
    const k = fakeKratos();
    // Kratos "accepts" the PUT but the stored credential is not what we sent.
    const real = k.admin.updateIdentity;
    k.admin.updateIdentity = async (a) => {
      await real(a);
      k.setStored("something-else");
    };
    const err = await run(k).catch((e) => e);
    expect(err).toBeInstanceOf(PasswordStepError);
    expect(err.step).toBe("verification-login-failed");
  });

  it("reports kratos-refused-password when Kratos rejects the PUT, without attempting login", async () => {
    const k = fakeKratos({ refuse: 400 });
    const f = vi.fn(k.fetchImpl);
    const err = await setPasswordAndVerify({
      admin: k.admin,
      identityId: "id1",
      email: "x@y.z",
      password: "short",
      publicUrl: URL_,
      fetchImpl: f,
    }).catch((e) => e);
    expect(err.step).toBe("kratos-refused-password");
    expect(f).not.toHaveBeenCalled();
  });

  it("reports verification failure when Kratos public API is unreachable", async () => {
    const k = fakeKratos();
    const err = await setPasswordAndVerify({
      admin: k.admin,
      identityId: "id1",
      email: "x@y.z",
      password: "pw-long-enough",
      publicUrl: URL_,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    }).catch((e) => e);
    expect(err.step).toBe("verification-login-failed");
  });
});
