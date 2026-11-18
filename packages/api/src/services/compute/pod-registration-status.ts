/**
 * Whether a new pod's server registered — asked of the Control Plane, which
 * minted the code and saw the registration (plan a640c5bb B1, founder 18 Nov
 * 2026: a successful `/pods/register` keeps the server its start's lease
 * would otherwise destroy at its TTL).
 *
 * The pod PULLS it: the Control Plane cannot know which pod started the
 * server (the agent ran the start on the person's pod, not through the CP).
 * The pod sends only the code's sha256, never the code; the CP stores the same
 * digest. `GET {cp}/internal/pod-registrations/:codeHash`, through the one
 * pod→CP credential door (`podCpAuthHeaders`, purpose `compute`).
 *
 * THREE answers, never two: `registered`, `not_registered` (the CP read the
 * code and it has not registered, or the CP has never minted it), and
 * `unread` (no Control Plane, no credential, a refusal, a failure). An
 * unread answer is NOT a "no": the sweeper never destroys on it.
 */
import { podCpAuthHeaders } from "@synap/database";
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";

export type PodRegistrationStatus =
  | { state: "registered"; podId: string | null }
  | { state: "not_registered" }
  | { state: "unread"; reason: string };

const HASH_RE = /^[0-9a-f]{64}$/;

export async function readPodRegistrationStatus(
  codeHash: string
): Promise<PodRegistrationStatus> {
  if (!HASH_RE.test(codeHash)) {
    return { state: "unread", reason: "the lease's code digest is malformed" };
  }
  const base = controlPlaneBaseUrl();
  if (!base) {
    return { state: "unread", reason: "this pod has no Control Plane" };
  }
  let auth: Awaited<ReturnType<typeof podCpAuthHeaders>>;
  try {
    auth = await podCpAuthHeaders({
      purpose: "compute",
      legacy: "internal-key",
      controlPlaneUrl: base,
    });
  } catch (err) {
    return {
      state: "unread",
      reason: `this pod's Control Plane credential cannot be used (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  if (!auth) {
    return { state: "unread", reason: "this pod has no Control Plane credential" };
  }
  let res: Response;
  try {
    res = await fetch(
      `${base.replace(/\/$/, "")}/internal/pod-registrations/${codeHash}`,
      { headers: auth.headers, signal: AbortSignal.timeout(10_000) }
    );
  } catch (err) {
    return {
      state: "unread",
      reason: `the Control Plane did not answer (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  const body = (await res.json().catch(() => null)) as {
    registered?: unknown;
    podId?: unknown;
    code?: unknown;
  } | null;
  // Only the CP's own "never minted" is a no: a bare 404 may be a Control
  // Plane that does not have this route yet.
  if (res.status === 404 && body?.code === "REGISTRATION_UNKNOWN") {
    return { state: "not_registered" };
  }
  if (!res.ok || typeof body?.registered !== "boolean") {
    return {
      state: "unread",
      reason: `the Control Plane answered ${res.status}`,
    };
  }
  return body.registered
    ? {
        state: "registered",
        podId: typeof body.podId === "string" ? body.podId : null,
      }
    : { state: "not_registered" };
}
