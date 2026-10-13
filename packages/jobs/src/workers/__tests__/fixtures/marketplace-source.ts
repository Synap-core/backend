/**
 * A local marketplace source for tests: a REAL ed25519 keypair, a signed
 * `synap-index.json`, definitions with their digests, served through an
 * injected fetch that records every request (so a test can prove what the
 * pod did and did not send).
 */

import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

export interface FixtureKey {
  publicKey: string;
  privateKey: KeyObject;
}

export function makeKey(): FixtureKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64"),
    privateKey,
  };
}

export const FIXTURE_ORIGIN = "https://market.acme.test";

export interface FixturePackage {
  slug: string;
  kind: string;
  definition: Record<string, unknown>;
  definitionUrl?: string;
  extra?: Record<string, unknown>;
}

export interface FixtureSource {
  /** Every request the pod made: URL + the init it passed. */
  requests: Array<{ url: string; init: RequestInit | undefined }>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** Replace a served body (to tamper with it). */
  serve: (path: string, body: string | Buffer | null, status?: number) => void;
  indexBytes: Buffer;
  sha256: Record<string, string>;
}

export function makeSource(opts: {
  key: FixtureKey | null;
  /** The key the index DECLARES (defaults to the signing key). */
  declaredKey?: string | null;
  id?: string;
  expires?: string;
  packages: FixturePackage[];
}): FixtureSource {
  const files = new Map<string, { body: Buffer; status: number }>();
  const sha256: Record<string, string> = {};
  const packages = opts.packages.map((p) => {
    const body = Buffer.from(JSON.stringify(p.definition));
    const path = `/defs/${p.slug.replace("/", "-")}.json`;
    files.set(path, { body, status: 200 });
    sha256[p.slug] = createHash("sha256").update(body).digest("hex");
    return {
      slug: p.slug,
      kind: p.kind,
      version: "h-0123456789ab",
      displayName: p.slug.toUpperCase(),
      definitionUrl: p.definitionUrl ?? `defs/${p.slug.replace("/", "-")}.json`,
      sha256: sha256[p.slug],
      ...p.extra,
    };
  });
  const declared =
    opts.declaredKey === undefined
      ? (opts.key?.publicKey ?? null)
      : opts.declaredKey;
  const indexBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      source: {
        id: opts.id ?? "acme",
        name: "Acme Labs",
        ...(declared ? { publicKey: declared } : {}),
      },
      expires: opts.expires ?? "2026-11-01T00:00:00Z",
      packages,
    })
  );
  files.set("/synap-index.json", { body: indexBytes, status: 200 });
  if (opts.key) {
    files.set("/synap-index.json.sig", {
      body: Buffer.from(
        sign(null, indexBytes, opts.key.privateKey).toString("base64") + "\n"
      ),
      status: 200,
    });
  }
  const requests: FixtureSource["requests"] = [];
  return {
    requests,
    indexBytes,
    sha256,
    serve(path, body, status = 200) {
      if (body === null) files.delete(path);
      else files.set(path, { body: Buffer.from(body), status });
    },
    async fetchImpl(url, init) {
      requests.push({ url, init });
      const u = new URL(url);
      const file =
        u.origin === FIXTURE_ORIGIN ? files.get(u.pathname) : undefined;
      if (!file) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(file.body), { status: file.status });
    },
  };
}
