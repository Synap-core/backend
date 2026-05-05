/**
 * Liveness probe — never gated by middleware so the deploy pipeline can
 * verify the Next.js process is alive without holding a Kratos session.
 */
export const dynamic = "force-static";

export function GET() {
  return Response.json({ ok: true, app: "pod-admin" });
}
