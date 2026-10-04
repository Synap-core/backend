/**
 * Password handling for `synap users reset-password|add-admin`.
 *
 * - The secret arrives on STDIN (never argv / env / a shell string).
 * - A password is only reported as set after a REAL Kratos login with it
 *   succeeds (API login flow), so "success" is proven, not assumed.
 *
 * Pure + dependency-injected so it is testable without a Kratos.
 */

export type PasswordStep =
  | "identity-not-found"
  | "kratos-refused-password"
  | "verification-login-failed";

export class PasswordStepError extends Error {
  constructor(
    public readonly step: PasswordStep,
    message: string
  ) {
    super(message);
    this.name = "PasswordStepError";
  }
}

/** Strip exactly one trailing line terminator; the secret may contain spaces. */
export function parseSecretFromStdin(raw: string): string {
  const secret = raw.replace(/\r?\n$/, "");
  if (secret.length === 0) {
    throw new Error("No password received on stdin (empty input)");
  }
  return secret;
}

export async function readStdin(
  stream: NodeJS.ReadableStream
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface KratosIdentityLike {
  id: string;
  schema_id: string;
  state?: string;
  traits?: Record<string, unknown>;
  metadata_public?: unknown;
  metadata_admin?: unknown;
}

export interface KratosAdminLike {
  getIdentity(args: { id: string }): Promise<{ data: KratosIdentityLike }>;
  updateIdentity(args: {
    id: string;
    updateIdentityBody: Record<string, unknown>;
  }): Promise<unknown>;
}

function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

/**
 * Admin PUT of credentials.password. Works for an identity that has NO
 * password credential yet (e.g. re-created after a restore). Carries
 * metadata_public/metadata_admin forward: a PUT replaces the identity, so
 * omitting them would silently erase them.
 */
export async function setIdentityPassword(
  admin: KratosAdminLike,
  identityId: string,
  password: string
): Promise<KratosIdentityLike> {
  const { data: identity } = await admin.getIdentity({ id: identityId });
  const body: Record<string, unknown> = {
    schema_id: identity.schema_id,
    state: identity.state ?? "active",
    traits: identity.traits ?? {},
    credentials: { password: { config: { password } } },
  };
  if (identity.metadata_public !== undefined)
    body.metadata_public = identity.metadata_public;
  if (identity.metadata_admin !== undefined)
    body.metadata_admin = identity.metadata_admin;
  try {
    await admin.updateIdentity({ id: identityId, updateIdentityBody: body });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 400 || status === 422) {
      throw new PasswordStepError(
        "kratos-refused-password",
        `Kratos refused the password (HTTP ${status}): too short, breached, or too similar to the identifier`
      );
    }
    throw error;
  }
  return identity;
}

/** Real login proof: API login flow, then password submit, expect HTTP 200. */
export async function verifyPasswordLogin(
  publicUrl: string,
  identifier: string,
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const base = publicUrl.replace(/\/$/, "");
  const fail = (why: string) =>
    new PasswordStepError(
      "verification-login-failed",
      `Password was written but the verification login FAILED: ${why}`
    );
  let flowId: string;
  try {
    const flowRes = await fetchImpl(`${base}/self-service/login/api`, {
      headers: { Accept: "application/json" },
    });
    if (!flowRes.ok)
      throw fail(`could not start a login flow (HTTP ${flowRes.status})`);
    flowId = ((await flowRes.json()) as { id?: string }).id ?? "";
    if (!flowId) throw fail("login flow had no id");
  } catch (e) {
    if (e instanceof PasswordStepError) throw e;
    throw fail(`Kratos public API unreachable at ${base}`);
  }
  let res: Response;
  try {
    res = await fetchImpl(
      `${base}/self-service/login?flow=${encodeURIComponent(flowId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ method: "password", identifier, password }),
      }
    );
  } catch {
    throw fail(`Kratos public API unreachable at ${base}`);
  }
  if (res.status !== 200) throw fail(`Kratos answered HTTP ${res.status}`);
}

/** Set + prove. Resolves only when the new password really logs in. */
export async function setPasswordAndVerify(opts: {
  admin: KratosAdminLike;
  identityId: string;
  email: string;
  password: string;
  publicUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const identity = await setIdentityPassword(
    opts.admin,
    opts.identityId,
    opts.password
  );
  const identifier =
    typeof identity.traits?.email === "string"
      ? identity.traits.email
      : opts.email;
  await verifyPasswordLogin(
    opts.publicUrl,
    identifier,
    opts.password,
    opts.fetchImpl
  );
}
