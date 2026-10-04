/**
 * The pod courier (SMTP) self-report — one reader shared by the provision
 * status (`routers/provision.ts`) and account recovery's "Email me a code"
 * door (`routers/account-recovery.ts`), so the two can never disagree about
 * whether mail leaves this pod.
 */

/**
 * Reports whether the pod's SMTP courier is wired to a real relay.
 *
 * Reads `SMTP_CONNECTION_URI` (mirrored from .env into the backend container
 * by docker-compose so we can self-introspect — Kratos itself reads
 * COURIER_SMTP_CONNECTION_URI directly, which is the same value).
 *
 * The localhost:1025 default is a catch-all that swallows mail without
 * delivering it. Users hit this when CP didn't pass --smtp-uri at provision
 * time, which makes password reset and Kratos recovery emails silently fail.
 */
export function courierStatus(): {
  status: "configured" | "catchall" | "unknown";
  host: string | null;
  // Only populated when status==="configured". Helps users sanity-check that
  // they actually configured the relay they think they did (e.g. resend.com).
  scheme: string | null;
} {
  const uri = process.env.SMTP_CONNECTION_URI;
  if (!uri) {
    return { status: "unknown", host: null, scheme: null };
  }
  let host: string | null = null;
  let scheme: string | null = null;
  try {
    const u = new URL(uri);
    host = u.hostname || null;
    scheme = u.protocol.replace(/:$/, "") || null;
  } catch {
    // malformed URI — treat as unknown rather than catchall, since we can't
    // tell what the operator intended.
    return { status: "unknown", host: null, scheme: null };
  }
  const isCatchAll =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  return {
    status: isCatchAll ? "catchall" : "configured",
    host,
    scheme,
  };
}
