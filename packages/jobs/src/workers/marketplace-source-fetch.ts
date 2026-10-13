/**
 * Marketplace source fetches — the ONLY way the pod talks to a third-party
 * source. Every request here is an anonymous GET:
 *   - no cookies, no Authorization, no pod key, no relay token — the request
 *     carries nothing but `Accept`, so a source learns that a pod asked and
 *     nothing about who it is;
 *   - https only, and redirects are refused (a redirect could point the pod
 *     at an address the person never chose — an internal one included);
 *   - a definition is fetched only from the index's OWN origin, so a signed
 *     index cannot steer the pod at any other host;
 *   - every body is read through a byte cap and dropped past it.
 *
 * The verdicts on what comes back live in `marketplace-source-verify.ts`.
 */

import {
  MARKETPLACE_INDEX_FILE,
  MARKETPLACE_INDEX_MAX_BYTES,
  MARKETPLACE_SIGNATURE_MAX_BYTES,
  MARKETPLACE_SIGNATURE_SUFFIX,
} from "@synap-core/types/marketplace-source";

/** The fetch signature the pod uses; tests inject their own. */
export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8000;

/** The exact request init every source fetch uses — nothing pod-identifying. */
export function anonymousGetInit(): RequestInit {
  return {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/**
 * The index URL for what a person typed: an address ending in `.json` IS the
 * index; anything else is a base the index sits under. Null when it is not an
 * https address.
 */
export function indexUrlFor(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith(".json")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${MARKETPLACE_INDEX_FILE}`;
  }
  return url.toString();
}

/**
 * Resolve a package's `definitionUrl` against its index. Null unless it is
 * https on the index's own origin.
 */
export function resolveDefinitionUrl(
  indexUrl: string,
  definitionUrl: string
): string | null {
  try {
    const base = new URL(indexUrl);
    const url = new URL(definitionUrl, base);
    if (url.protocol !== "https:" || url.origin !== base.origin) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export type CappedRead =
  { ok: true; bytes: Uint8Array } | { ok: false; tooLarge: true };

/** Read a body, giving up (and cancelling the stream) past `max` bytes. */
export async function readCapped(
  res: Response,
  max: number
): Promise<CappedRead> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, tooLarge: true };
  }
  if (!res.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export type IndexFetch =
  | {
      ok: true;
      indexUrl: string;
      indexBytes: Uint8Array;
      /** The `.sig` body; null when the source serves none (404). */
      signature: string | null;
    }
  | {
      ok: false;
      reason: "bad_address" | "unreachable" | "too_large";
      message: string;
    };

async function get(
  url: string,
  fetchImpl: SourceFetch
): Promise<Response | null> {
  try {
    return await fetchImpl(url, anonymousGetInit());
  } catch {
    return null;
  }
}

/** Fetch a source's index and its detached signature. Never throws. */
export async function fetchSourceIndex(
  address: string,
  fetchImpl: SourceFetch = fetch
): Promise<IndexFetch> {
  const indexUrl = indexUrlFor(address);
  if (!indexUrl) {
    return {
      ok: false,
      reason: "bad_address",
      message: "A source address is an https:// address.",
    };
  }
  const res = await get(indexUrl, fetchImpl);
  if (!res) {
    return {
      ok: false,
      reason: "unreachable",
      message: `The pod couldn't reach ${new URL(indexUrl).host}.`,
    };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: "unreachable",
      message:
        res.status === 404
          ? `There is no ${MARKETPLACE_INDEX_FILE} at that address.`
          : `The source answered ${res.status}.`,
    };
  }
  const body = await readCapped(res, MARKETPLACE_INDEX_MAX_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      reason: "too_large",
      message: `The index is larger than ${MARKETPLACE_INDEX_MAX_BYTES / 1024 / 1024} MB, so the pod did not read it.`,
    };
  }

  const sigRes = await get(
    `${indexUrl}${MARKETPLACE_SIGNATURE_SUFFIX}`,
    fetchImpl
  );
  if (!sigRes) {
    return {
      ok: false,
      reason: "unreachable",
      message: "The pod couldn't fetch the index signature.",
    };
  }
  let signature: string | null = null;
  if (sigRes.status === 404) {
    await sigRes.body?.cancel().catch(() => undefined);
  } else if (!sigRes.ok) {
    await sigRes.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: "unreachable",
      message: `The source answered ${sigRes.status} for the index signature.`,
    };
  } else {
    const sig = await readCapped(sigRes, MARKETPLACE_SIGNATURE_MAX_BYTES);
    // An oversized signature is no signature: the verifier then refuses it.
    signature = sig.ok ? new TextDecoder().decode(sig.bytes) : "";
  }
  return { ok: true, indexUrl, indexBytes: body.bytes, signature };
}

export type DefinitionFetch =
  { ok: true; bytes: Uint8Array } | { ok: false; message: string };

/** Fetch one definition's bytes (the caller verifies the digest). Never throws. */
export async function fetchDefinitionBytes(
  url: string,
  maxBytes: number,
  fetchImpl: SourceFetch = fetch
): Promise<DefinitionFetch> {
  const res = await get(url, fetchImpl);
  if (!res) {
    return {
      ok: false,
      message: `The pod couldn't reach ${new URL(url).host}.`,
    };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      message: `The source answered ${res.status} for the definition.`,
    };
  }
  const body = await readCapped(res, maxBytes);
  if (!body.ok) {
    return {
      ok: false,
      message: `The definition is larger than ${Math.round(maxBytes / 1024)} KB.`,
    };
  }
  return { ok: true, bytes: body.bytes };
}
